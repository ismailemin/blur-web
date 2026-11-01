#include "pak_reader.h"
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void put(std::vector<unsigned char>& bytes, size_t offset, uint64_t value, unsigned width=4, bool big=false) {
    for (unsigned i=0;i<width;++i) bytes[offset+(big?width-i-1:i)] = static_cast<unsigned char>(value>>(i*8));
}
std::vector<unsigned char> fixture(bool big=false, bool secure=false, bool v1=false) {
    std::vector<unsigned char> bytes(256,0);
    std::memcpy(bytes.data(),big?"PAK2":"2KAP",4);
    put(bytes,4,v1?1:2,4,big); put(bytes,8,64,4,big); put(bytes,12,v1?40:32,4,big);
    const size_t settings=v1?36:16;
    bytes[settings]=1;bytes[settings+1]=secure?1:0;bytes[settings+2]='\\';
    const size_t st=v1?56:64;
    const std::string name="\\tiny.model";
    put(bytes,st,name.size()+1,4,big);
    constexpr unsigned char cipher[]="xVXo40j3@$%\\%`";
    for(size_t i=0;i<=name.size();++i)bytes[st+4+i]=static_cast<unsigned char>((i<name.size()?name[i]:0)^cipher[(i+1)%14]);
    const uint32_t stride=(v1?32:40)+(secure?24:0);
    if(!v1){put(bytes,36,64,4,big);put(bytes,40,secure?128:64,4,big);}
    put(bytes,128,1,4,big);put(bytes,132,stride,4,big);
    put(bytes,136,123,4,big);put(bytes,140,0,4,big);put(bytes,144,UINT32_MAX,4,big);
    put(bytes,148,4,4,big);put(bytes,160,secure?4:3,8,big);
    if(!v1)put(bytes,172,4,4,big);
    if(secure)bytes.resize(320,0);
    return bytes;
}
std::string inspect(const std::vector<unsigned char>& data, size_t prefix=SIZE_MAX, double file_size=-1) {
    if(prefix==SIZE_MAX)prefix=data.size();
    if(file_size<0)file_size=static_cast<double>(data.size());
    char* raw=pak_inspect(data.data(),prefix,file_size);
    check(raw!=nullptr,"Expected JSON allocation");std::string result(raw);pak_free(raw);return result;
}
void expect(const std::string& text,const char* fragment){check(text.find(fragment)!=std::string::npos,fragment);}
}
int main() {
    try {
        for(bool big:{false,true})for(bool secure:{false,true})for(bool v1:{false,true}) {
            auto data=fixture(big,secure,v1);const auto json=inspect(data);
            expect(json,"\"status\":\"ok\"");expect(json,"tiny.model");expect(json,"\"fileCount\":1");
            expect(json,"\"validationPerformed\":false");
            if(v1)expect(json,"\"physicalBytes\":null");
        }
        auto data=fixture();expect(inspect(data,12),"\"status\":\"need_more\"");
        expect(inspect(data,64),"\"requiredBytes\":192");
        expect(inspect(data,16,16),"\"status\":\"error\"");
        expect(inspect(data,data.size(),std::numeric_limits<double>::infinity()),"\"status\":\"error\"");
        expect(inspect(data,data.size(),12.5),"\"status\":\"error\"");
        expect(inspect(data,data.size(),9007199254740992.0),"\"status\":\"error\"");
        auto bad=data;put(bad,4,3);expect(inspect(bad),"Unsupported PAK version");
        bad=data;put(bad,8,63);expect(inspect(bad),"Invalid sector size");
        bad=data;put(bad,36,128*1024*1024);expect(inspect(bad,bad.size(),256*1024*1024),"64 MiB");
        bad=data;put(bad,128,100001);expect(inspect(bad),"Entry count");
        bad=data;put(bad,132,39);expect(inspect(bad),"FAT length");
        bad=data;put(bad,140,999);expect(inspect(bad),"String table offset");
        bad=data;put(bad,144,1);expect(inspect(bad),"Parent FAT offset");
        bad=data;put(bad,160,UINT64_MAX-1,8);expect(inspect(bad),"Payload offset overflow");
        bad=data;put(bad,172,200);expect(inspect(bad),"Payload range");
        bad=data;bad[17]=2;expect(inspect(bad),"Unsupported FAT");
        bad=data;bad[16]=0;expect(inspect(bad),"Unsupported PAK codec");
        // Destroy the terminating null after decoding without touching the header.
        bad=data;bad[64+4+11]^=1;expect(inspect(bad),"Unterminated path");
        std::cout << "PASS: 8 endian/version/FAT fixtures and 16 invalid/truncated input checks\n";
        return 0;
    } catch(const std::exception& error) { std::cerr << "FAIL: " << error.what() << '\n'; return 1; }
}
