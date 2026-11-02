// Minimal deterministic JSON emitter. No dependency on any JSON library so the
// probe stays a single self-contained unit that builds identically natively and
// under emscripten.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace schedprobe {

class JsonEmitter {
public:
    explicit JsonEmitter(std::string& out) : out_(out) {}

    void beginObject() { open('{'); }
    void endObject() { close('}'); }
    void beginArray() { open('['); }
    void endArray() { close(']'); }

    void key(const char* name) {
        pre();
        out_ += '"';
        escape(name);
        out_ += "\": ";
        pendingValue_ = true;
    }

    void i64(std::int64_t value) { pre(); appendSigned(value); done(); }
    void u64(std::uint64_t value) { pre(); appendUnsigned(value); done(); }
    void boolean(bool value) { pre(); out_ += value ? "true" : "false"; done(); }
    void str(const std::string& value) { pre(); out_ += '"'; escape(value); out_ += '"'; done(); }
    void str(const char* value) { str(std::string(value)); }

    void arrayI64(const std::vector<std::int64_t>& values) {
        pre();
        out_ += '[';
        for (std::size_t i = 0; i < values.size(); ++i) {
            if (i != 0) {
                out_ += ',';
            }
            appendSigned(values[i]);
        }
        out_ += ']';
        done();
    }

    void arrayU32AsI64(const std::vector<unsigned>& values) {
        pre();
        out_ += '[';
        for (std::size_t i = 0; i < values.size(); ++i) {
            if (i != 0) {
                out_ += ',';
            }
            appendUnsigned(values[i]);
        }
        out_ += ']';
        done();
    }

private:
    void pre() {
        if (pendingValue_) {
            pendingValue_ = false;
            return;
        }
        if (!stack_.empty()) {
            if (stack_.back() != 0) {
                out_ += ',';
            }
            out_ += '\n';
            indent();
        }
    }

    void open(char c) {
        pre();
        out_ += c;
        stack_.push_back(0);
    }

    void close(char c) {
        const std::size_t items = stack_.back();
        stack_.pop_back();
        if (items != 0) {
            out_ += '\n';
            indent();
        }
        out_ += c;
        done();
    }

    void done() {
        if (!stack_.empty()) {
            ++stack_.back();
        }
    }

    void indent() { out_.append(stack_.size() * 2u, ' '); }

    void appendSigned(std::int64_t value) {
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(value));
        out_ += buffer;
    }

    void appendUnsigned(std::uint64_t value) {
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
        out_ += buffer;
    }

    void escape(const std::string& text) {
        for (const char c : text) {
            const unsigned char u = static_cast<unsigned char>(c);
            switch (c) {
            case '"': out_ += "\\\""; break;
            case '\\': out_ += "\\\\"; break;
            case '\n': out_ += "\\n"; break;
            case '\r': out_ += "\\r"; break;
            case '\t': out_ += "\\t"; break;
            default:
                if (u < 0x20) {
                    char buffer[8];
                    std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned>(u));
                    out_ += buffer;
                } else {
                    out_ += c;
                }
                break;
            }
        }
    }

    std::string& out_;
    std::vector<std::size_t> stack_;
    bool pendingValue_ = false;
};

} // namespace schedprobe
