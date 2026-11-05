// T-006b layout probe — native entry point.
//
//   net_layout_probe [--out <file>] [--selftest]
//
// Exit codes: 0 ok, 1 self-test failure, 2 bad argument, 3 write failure.

#include "probe_core.h"

#include <cstdio>
#include <cstring>
#include <string>

int main(int argc, char** argv)
{
	const char* outPath = nullptr;
	bool selftest = false;

	for (int i = 1; i < argc; ++i)
	{
		if (std::strcmp(argv[i], "--out") == 0 && i + 1 < argc)
		{
			outPath = argv[++i];
		}
		else if (std::strcmp(argv[i], "--selftest") == 0)
		{
			selftest = true;
		}
		else
		{
			std::fprintf(stderr, "net_layout_probe: bad argument '%s'\n", argv[i]);
			return 2;
		}
	}

	if (selftest)
	{
		std::string err;
		if (!wireprobe::selfTest(err))
		{
			std::fprintf(stderr, "net_layout_probe: selftest FAILED: %s\n", err.c_str());
			return 1;
		}
		std::printf("net_layout_probe: selftest PASS\n");
		return 0;
	}

	const std::string json = wireprobe::layoutJson();
	if (outPath)
	{
		std::FILE* f = std::fopen(outPath, "wb");
		if (!f)
		{
			std::fprintf(stderr, "net_layout_probe: cannot open '%s'\n", outPath);
			return 3;
		}
		const size_t n = std::fwrite(json.data(), 1, json.size(), f);
		std::fclose(f);
		if (n != json.size())
		{
			std::fprintf(stderr, "net_layout_probe: short write '%s'\n", outPath);
			return 3;
		}
		std::printf("net_layout_probe: wrote %s (%d bytes)\n", outPath, (int)json.size());
	}
	else
	{
		std::fwrite(json.data(), 1, json.size(), stdout);
	}
	return 0;
}
