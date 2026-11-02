// Deterministic byte/JSON/SHA-256 helpers. No locale, no libc float formatting:
// every float is emitted as its 8-digit hex bit pattern so native and wasm32
// documents are byte-identical.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace oracle
{
	inline std::uint32_t f32_bits(float v)
	{
		std::uint32_t bits = 0;
		std::memcpy(&bits, &v, 4);
		return bits;
	}

	inline std::string hex8(std::uint32_t v)
	{
		static const char* digits = "0123456789abcdef";
		std::string s(8, '0');
		for (int i = 7; i >= 0; --i)
		{
			s[static_cast<std::size_t>(i)] = digits[v & 0xFu];
			v >>= 4;
		}
		return s;
	}

	inline std::string hex_bytes(const std::vector<std::uint8_t>& bytes)
	{
		static const char* digits = "0123456789abcdef";
		std::string s;
		s.reserve(bytes.size() * 2);
		for (std::uint8_t b : bytes)
		{
			s.push_back(digits[(b >> 4) & 0xF]);
			s.push_back(digits[b & 0xF]);
		}
		return s;
	}

	class Bin
	{
	public:
		void u8(std::uint8_t v) { m_data.push_back(v); }
		void u16(std::uint16_t v)
		{
			m_data.push_back(static_cast<std::uint8_t>(v & 0xFF));
			m_data.push_back(static_cast<std::uint8_t>((v >> 8) & 0xFF));
		}
		void u32(std::uint32_t v)
		{
			for (int i = 0; i < 4; ++i) m_data.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 0xFF));
		}
		void f32(float v) { u32(f32_bits(v)); }
		void vec3(float x, float y, float z) { f32(x); f32(y); f32(z); }

		const std::vector<std::uint8_t>& data() const { return m_data; }
		std::vector<std::uint8_t>& data() { return m_data; }

	private:
		std::vector<std::uint8_t> m_data;
	};

	// ------------------------------------------------------------------- SHA-256

	class Sha256
	{
	public:
		Sha256() { reset(); }

		void reset()
		{
			static const std::uint32_t init[8] = {
				0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
				0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
			std::memcpy(m_state, init, sizeof(m_state));
			m_total = 0;
			m_used = 0;
		}

		void update(const std::uint8_t* data, std::size_t size)
		{
			m_total += size;
			while (size > 0)
			{
				const std::size_t take = (size < 64 - m_used) ? size : (64 - m_used);
				std::memcpy(m_block + m_used, data, take);
				m_used += take;
				data += take;
				size -= take;
				if (m_used == 64)
				{
					compress(m_block);
					m_used = 0;
				}
			}
		}

		std::string hex_digest()
		{
			const std::uint64_t bit_length = m_total * 8ull;
			const std::uint8_t pad = 0x80;
			update(&pad, 1);
			const std::uint8_t zero = 0;
			while (m_used != 56) update(&zero, 1);
			std::uint8_t length_bytes[8];
			for (int i = 0; i < 8; ++i)
				length_bytes[i] = static_cast<std::uint8_t>((bit_length >> (8 * (7 - i))) & 0xFF);
			update(length_bytes, 8);

			static const char* digits = "0123456789abcdef";
			std::string out;
			out.reserve(64);
			for (int i = 0; i < 8; ++i)
			{
				for (int b = 3; b >= 0; --b)
				{
					const std::uint8_t byte = static_cast<std::uint8_t>((m_state[i] >> (8 * b)) & 0xFF);
					out.push_back(digits[(byte >> 4) & 0xF]);
					out.push_back(digits[byte & 0xF]);
				}
			}
			return out;
		}

	private:
		static std::uint32_t rotr(std::uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

		void compress(const std::uint8_t* block)
		{
			static const std::uint32_t k[64] = {
				0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
				0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
				0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
				0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
				0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
				0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
				0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
				0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};

			std::uint32_t w[64];
			for (int i = 0; i < 16; ++i)
			{
				w[i] = (static_cast<std::uint32_t>(block[i * 4]) << 24) |
				       (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
				       (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) |
				       static_cast<std::uint32_t>(block[i * 4 + 3]);
			}
			for (int i = 16; i < 64; ++i)
			{
				const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
				const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
				w[i] = w[i - 16] + s0 + w[i - 7] + s1;
			}

			std::uint32_t a = m_state[0], b = m_state[1], c = m_state[2], d = m_state[3];
			std::uint32_t e = m_state[4], f = m_state[5], g = m_state[6], h = m_state[7];
			for (int i = 0; i < 64; ++i)
			{
				const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				const std::uint32_t ch = (e & f) ^ (~e & g);
				const std::uint32_t t1 = h + s1 + ch + k[i] + w[i];
				const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
				const std::uint32_t t2 = s0 + maj;
				h = g; g = f; f = e; e = d + t1;
				d = c; c = b; b = a; a = t1 + t2;
			}
			m_state[0] += a; m_state[1] += b; m_state[2] += c; m_state[3] += d;
			m_state[4] += e; m_state[5] += f; m_state[6] += g; m_state[7] += h;
		}

		std::uint32_t m_state[8];
		std::uint64_t m_total;
		std::uint8_t m_block[64];
		std::size_t m_used;
	};

	inline std::string sha256_hex(const std::uint8_t* data, std::size_t size)
	{
		Sha256 h;
		h.update(data, size);
		return h.hex_digest();
	}

	inline std::string json_escape(const std::string& in)
	{
		std::string out;
		out.reserve(in.size() + 8);
		static const char* digits = "0123456789abcdef";
		for (char c : in)
		{
			const unsigned char u = static_cast<unsigned char>(c);
			if (c == '"') out += "\\\"";
			else if (c == '\\') out += "\\\\";
			else if (c == '\n') out += "\\n";
			else if (c == '\r') out += "\\r";
			else if (c == '\t') out += "\\t";
			else if (u < 0x20)
			{
				out += "\\u00";
				out.push_back(digits[(u >> 4) & 0xF]);
				out.push_back(digits[u & 0xF]);
			}
			else
			{
				out.push_back(c);
			}
		}
		return out;
	}

	// ---------------------------------------------------------------------- JSON

	class Json
	{
	public:
		void raw(const std::string& s) { m_out += s; }
		void begin_object()
		{
			prefix();
			m_out += '{';
			push(false);
		}
		void end_object()
		{
			m_out += '}';
			pop();
		}
		void begin_array()
		{
			prefix();
			m_out += '[';
			push(false);
		}
		void end_array()
		{
			m_out += ']';
			pop();
		}
		void key(const std::string& k)
		{
			prefix();
			m_out += '"';
			m_out += k;
			m_out += "\":";
			m_pendingKey = true;
		}
		void value_string(const std::string& v)
		{
			prefix();
			m_out += '"';
			m_out += json_escape(v);
			m_out += '"';
			finish_value();
		}
		void value_u32(std::uint32_t v) { prefix(); m_out += std::to_string(v); finish_value(); }
		void value_u64(std::uint64_t v) { prefix(); m_out += std::to_string(v); finish_value(); }
		void value_i32(std::int32_t v) { prefix(); m_out += std::to_string(v); finish_value(); }
		void value_bool(bool v) { prefix(); m_out += v ? "true" : "false"; finish_value(); }
		void value_null() { prefix(); m_out += "null"; finish_value(); }
		void value_bits(float v)
		{
			prefix();
			m_out += '"';
			m_out += hex8(f32_bits(v));
			m_out += '"';
			finish_value();
		}
		void value_hex(std::uint32_t v)
		{
			prefix();
			m_out += '"';
			m_out += hex8(v);
			m_out += '"';
			finish_value();
		}

		const std::string& str() const { return m_out; }

	private:
		void push(bool need_comma)
		{
			m_stack.push_back(m_needComma);
			m_needComma = need_comma;
			m_pendingKey = false;
		}

		void pop()
		{
			if (!m_stack.empty())
			{
				m_needComma = m_stack.back();
				m_stack.pop_back();
			}
			finish_value();
		}

		void prefix()
		{
			if (m_pendingKey)
			{
				m_pendingKey = false;
				return;
			}
			if (m_needComma) m_out += ',';
		}

		void finish_value()
		{
			m_needComma = true;
			m_pendingKey = false;
		}

		std::string m_out;
		std::vector<bool> m_stack;
		bool m_needComma = false;
		bool m_pendingKey = false;
	};
}
