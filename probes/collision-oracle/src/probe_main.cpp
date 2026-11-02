// Native CLI. Reads one Level.levelphysics file and writes the oracle JSON.
//
//   collision_oracle --in <path> [--out <path>] [--selftest]
//
// Exit codes: 0 ok, 1 self-test failure, 2 bad argument, 3 read failure,
// 4 write failure, 5 oracle reported an error.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "oracle_run.h"

namespace
{
	void print_usage()
	{
		std::fprintf(stderr,
		             "usage: collision_oracle --in <Level.levelphysics> [--out <json>] [--selftest]\n");
	}
}

int main(int argc, char** argv)
{
	std::string in_path;
	std::string out_path;
	bool selftest = false;

	for (int i = 1; i < argc; ++i)
	{
		if (std::strcmp(argv[i], "--in") == 0 && i + 1 < argc)
			in_path = argv[++i];
		else if (std::strcmp(argv[i], "--out") == 0 && i + 1 < argc)
			out_path = argv[++i];
		else if (std::strcmp(argv[i], "--selftest") == 0)
			selftest = true;
		else
		{
			std::fprintf(stderr, "unknown argument: %s\n", argv[i]);
			print_usage();
			return 2;
		}
	}

	if (selftest)
	{
		const std::string failure = oracle::selftest();
		if (!failure.empty())
		{
			std::fprintf(stderr, "selftest: FAIL %s\n", failure.c_str());
			return 1;
		}
		std::printf("selftest: PASS\n");
		return 0;
	}

	if (in_path.empty())
	{
		print_usage();
		return 2;
	}

	std::ifstream f(in_path, std::ios::binary);
	if (!f)
	{
		std::fprintf(stderr, "cannot open %s\n", in_path.c_str());
		return 3;
	}
	f.seekg(0, std::ios::end);
	const std::streamoff length = f.tellg();
	if (length < 0)
	{
		std::fprintf(stderr, "cannot determine size of %s\n", in_path.c_str());
		return 3;
	}
	f.seekg(0, std::ios::beg);
	std::vector<std::uint8_t> bytes(static_cast<std::size_t>(length));
	if (length > 0)
	{
		f.read(reinterpret_cast<char*>(bytes.data()), length);
		if (!f)
		{
			std::fprintf(stderr, "short read on %s\n", in_path.c_str());
			return 3;
		}
	}

	oracle::RunOptions options;
	options.inputLabel = in_path;
	options.target = "native-x64";
	options.flags = "MSVC /W4 /permissive- /fp:precise /O2";

	const std::string json = oracle::run(bytes.data(), bytes.size(), options);

	if (out_path.empty())
	{
		std::fwrite(json.data(), 1, json.size(), stdout);
		std::fputc('\n', stdout);
	}
	else
	{
		std::ofstream o(out_path, std::ios::binary | std::ios::trunc);
		if (!o)
		{
			std::fprintf(stderr, "cannot write %s\n", out_path.c_str());
			return 4;
		}
		o.write(json.data(), static_cast<std::streamsize>(json.size()));
		if (!o)
		{
			std::fprintf(stderr, "write failed on %s\n", out_path.c_str());
			return 4;
		}
	}

	if (json.find("\"status\":\"error\"") != std::string::npos)
		return 5;
	return 0;
}
