// Unit tests. No game data is required for the rejection cases; when a path is
// given as argv[1] the real level file is also checked for determinism and
// structural invariants.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "level_physics.h"
#include "oracle_run.h"
#include "queries.h"

namespace
{
	int g_failures = 0;

	void check(bool condition, const char* what)
	{
		if (!condition)
		{
			std::printf("FAIL %s\n", what);
			++g_failures;
		}
	}

	void append_u16(std::vector<std::uint8_t>& b, std::uint16_t v)
	{
		b.push_back(static_cast<std::uint8_t>(v & 0xFF));
		b.push_back(static_cast<std::uint8_t>((v >> 8) & 0xFF));
	}

	void append_u32(std::vector<std::uint8_t>& b, std::uint32_t v)
	{
		for (int i = 0; i < 4; ++i) b.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xFF));
	}

	void append_block_header(std::vector<std::uint8_t>& b, const char* id, std::size_t size,
	                         std::uint16_t count, std::uint8_t type)
	{
		char raw[8] = {};
		const std::size_t idLength = std::strlen(id);
		std::memcpy(raw, id, idLength < 7 ? idLength : 7);
		b.insert(b.end(), raw, raw + 8);
		append_u32(b, static_cast<std::uint32_t>(size));
		append_u16(b, count);
		b.push_back(type);
		b.push_back(0);
	}

	// Root(Header, Main[Head v10, shape type]) with no shapes behind it.
	std::vector<std::uint8_t> synthetic_stream(std::uint32_t shapeType)
	{
		std::vector<std::uint8_t> mainBody;
		const char head[4] = {'H', 'e', 'a', 'd'};
		mainBody.insert(mainBody.end(), head, head + 4);
		append_u32(mainBody, 10);
		append_u32(mainBody, shapeType);

		std::vector<std::uint8_t> headerBody;
		append_u32(headerBody, 0);
		append_u32(headerBody, 0);

		const std::size_t headerBlockSize = 16 + headerBody.size();
		const std::size_t mainBlockSize = 16 + mainBody.size();
		const std::size_t rootSize = 16 + headerBlockSize + mainBlockSize;

		std::vector<std::uint8_t> b;
		const char marker[4] = {' ', ' ', 'C', 'P'};
		b.insert(b.end(), marker, marker + 4);
		append_block_header(b, "Physic", rootSize, 2, 0x43);
		append_block_header(b, "Header", headerBlockSize, 0, 0x41);
		b.insert(b.end(), headerBody.begin(), headerBody.end());
		append_block_header(b, "Main", mainBlockSize, 0, 0x41);
		b.insert(b.end(), mainBody.begin(), mainBody.end());
		return b;
	}
}

int main(int argc, char** argv)
{
	using namespace oracle;

	// 1. Structural self-test.
	{
		const std::string failure = selftest();
		if (!failure.empty())
		{
			std::printf("FAIL selftest: %s\n", failure.c_str());
			++g_failures;
		}
	}

	// 2. Rejection cases.
	{
		Level level;
		LoadError err;
		check(!load_level(nullptr, 0, level, err), "null input rejected");
		check(err.code == "file_too_small", "null input code");

		std::vector<std::uint8_t> zeros(64, 0);
		check(!load_level(zeros.data(), zeros.size(), level, err), "zero file rejected");
		check(err.code == "bad_pc_marker" && err.offset == 0, "zero file marker error");

		std::vector<std::uint8_t> badMarker = zeros;
		badMarker[0] = ' ';
		badMarker[1] = ' ';
		badMarker[2] = 'X';
		badMarker[3] = 'P';
		check(!load_level(badMarker.data(), badMarker.size(), level, err), "bad marker rejected");
		check(err.code == "bad_pc_marker", "bad marker code");

		std::vector<std::uint8_t> synthetic = synthetic_stream(7);
		check(!load_level(synthetic.data(), synthetic.size(), level, err), "unsupported shape rejected");
		check(err.code == "unsupported_shape_type", "unsupported shape code");
		// Main body starts at 60; "Head"(4) + version(4) = 68, shape type at 68.
		check(err.offset == 68, "unsupported shape offset");

		std::vector<std::uint8_t> triangleShape = synthetic_stream(0);
		check(!load_level(triangleShape.data(), triangleShape.size(), level, err),
		      "truncated triangle shape rejected");
		check(!err.code.empty(), "truncated triangle shape has a code");
		check(err.offset >= 72, "truncated triangle shape offset");

		// Every strict prefix must be rejected without crashing.
		for (std::size_t cut = 0; cut < synthetic.size(); ++cut)
		{
			Level partial;
			LoadError perr;
			if (load_level(synthetic.data(), cut, partial, perr))
			{
				std::printf("FAIL prefix %zu accepted\n", cut);
				++g_failures;
				break;
			}
			if (perr.code.empty())
			{
				std::printf("FAIL prefix %zu produced no error code\n", cut);
				++g_failures;
				break;
			}
		}
	}

	// 3. Optional real-file checks.
	if (argc > 1)
	{
		std::ifstream file(argv[1], std::ios::binary);
		if (!file)
		{
			std::printf("FAIL cannot open %s\n", argv[1]);
			++g_failures;
		}
		else
		{
			file.seekg(0, std::ios::end);
			const std::streamoff length = file.tellg();
			file.seekg(0, std::ios::beg);
			std::vector<std::uint8_t> bytes(static_cast<std::size_t>(length));
			file.read(reinterpret_cast<char*>(bytes.data()), length);
			check(file.good() || file.eof(), "real file fully read");

			Level level;
			LoadError err;
			check(load_level(bytes.data(), bytes.size(), level, err), "real file parses");
			if (err.ok())
			{
				check(level.meshes.size() == 2, "real file has two static meshes");
				check(total_triangle_count(level) > 1000, "real file has triangles");
				for (const Mesh& m : level.meshes)
				{
					check(m.triangleBufferBytes == m.triangleCapacityBytes,
					      "triangle buffer bytes equal the declared capacity");
					check(m.isIdentityInstance(), "mesh instance transform is identity");
					for (const TriangleRecord& t : m.triangles)
					{
						if (t.indexA >= m.leaves[t.leafIndex].numVertices ||
						    t.indexB >= m.leaves[t.leafIndex].numVertices ||
						    t.indexC >= m.leaves[t.leafIndex].numVertices)
						{
							check(false, "triangle index inside its leaf");
							break;
						}
					}
				}

				RunOptions options;
				options.target = "native-x64";
				const std::string first = run(bytes.data(), bytes.size(), options);
				const std::string second = run(bytes.data(), bytes.size(), options);
				check(first == second, "two runs are byte-identical");
				check(first.find("\"status\":\"ok\"") != std::string::npos, "run status ok");

				// Truncation at 64 evenly spaced offsets must be rejected.
				for (int i = 1; i <= 64; ++i)
				{
					const std::size_t cut = (bytes.size() * static_cast<std::size_t>(i)) / 65;
					LoadError terr;
					Level truncated;
					if (load_level(bytes.data(), cut, truncated, terr))
					{
						std::printf("FAIL real-file prefix %zu accepted\n", cut);
						++g_failures;
						break;
					}
				}
			}
			else
			{
				std::printf("FAIL real file error %s at %llu: %s\n", err.code.c_str(),
				            static_cast<unsigned long long>(err.offset), err.detail.c_str());
				++g_failures;
			}
		}
	}

	if (g_failures != 0)
	{
		std::printf("%d failure(s)\n", g_failures);
		return 1;
	}
	std::printf("all oracle tests passed\n");
	return 0;
}
