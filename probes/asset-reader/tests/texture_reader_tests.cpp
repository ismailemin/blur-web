#include "texture_reader.h"
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
namespace {
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
std::string inspect(const unsigned char* p,size_t n){char* json=texture_inspect(p,n);check(json!=nullptr,"Null texture result");std::string out(json);texture_free(json);return out;}
std::string inspect_raw(const unsigned char* p,size_t n){char* json=texture_raw_inspect(p,n);check(json!=nullptr,"Null raw texture result");std::string out(json);texture_free(json);return out;}
std::string rgba(const std::string& json){auto first=json.find("\"rgba\":[");check(first!=std::string::npos,"Missing RGBA result");return json.substr(first,json.find(']',first)-first+1);}
void set32(std::vector<unsigned char>& b,size_t p,uint32_t v){for(unsigned i=0;i<4;++i)b[p+i]=static_cast<unsigned char>(v>>(i*8));}
void block(std::vector<unsigned char>& b,size_t p,const char* id,uint32_t n,unsigned count,unsigned type){std::copy(id,id+std::char_traits<char>::length(id),b.begin()+p);set32(b,p+8,n);b[p+12]=static_cast<unsigned char>(count);b[p+14]=static_cast<unsigned char>(type);}
std::vector<unsigned char> fixture(uint32_t fmt,size_t size){std::vector<unsigned char> b(84+size);block(b,0,"Texture",static_cast<uint32_t>(b.size()),2,0x43);block(b,16,"Header",24,0,0x41);block(b,40,"Data",static_cast<uint32_t>(44+size),0,0x41);set32(b,56,4);set32(b,60,4);set32(b,64,1);set32(b,68,1);set32(b,72,fmt);set32(b,80,3);return b;}
void rejects(const std::vector<unsigned char>& b){check(inspect(b.data(),b.size()).find("\"status\":\"error\"")!=std::string::npos,"Malformed texture accepted");}
}
int main(int argc,char** argv){try{
    check(inspect(nullptr,0).find("error")!=std::string::npos,"Null accepted");
    unsigned char tiny=0;check(inspect(&tiny,std::numeric_limits<size_t>::max()).find("error")!=std::string::npos,"Oversize accepted");
    auto bc1=fixture(0x31545844,8);bc1[84]=0;bc1[85]=0xf8; // red565 > black, selector0
    check(inspect(bc1.data(),bc1.size()).find("\"rgba\":[255,0,0,255,255,0,0,255")!=std::string::npos,"BC1 red decode");
    auto transparent=fixture(0x31545844,8);transparent[86]=255;transparent[87]=255;set32(transparent,88,0xffffffff);
    check(inspect(transparent.data(),transparent.size()).find("\"rgba\":[0,0,0,0,0,0,0,0")!=std::string::npos,"BC1 transparent decode");
    auto bc2=fixture(0x33545844,16);std::fill(bc2.begin()+84,bc2.begin()+92,static_cast<unsigned char>(0x88));bc2[93]=0xf8;
    check(inspect(bc2.data(),bc2.size()).find("\"rgba\":[255,0,0,136")!=std::string::npos,"BC2 alpha decode");
    auto bc3=fixture(0x35545844,16);bc3[84]=255;bc3[85]=0;bc3[93]=0xf8;
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,255")!=std::string::npos,"BC3 alpha endpoint");
    std::fill(bc3.begin()+86,bc3.begin()+92,static_cast<unsigned char>(0x49)); // explicit first 3-bit selector1
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,0")!=std::string::npos,"BC3 alpha selector");
    bc3[86]=2;bc3[84]=240;bc3[85]=10;
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,207")!=std::string::npos,"BC3 rounded 8-alpha interpolation");
    bc3[84]=10;bc3[85]=240;
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,56")!=std::string::npos,"BC3 rounded 6-alpha interpolation");
    bc3[86]=6;
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,0")!=std::string::npos,"BC3 implicit zero");
    bc3[86]=7;
    check(inspect(bc3.data(),bc3.size()).find("\"rgba\":[255,0,0,255")!=std::string::npos,"BC3 implicit full alpha");
    auto bgra=fixture(21,64);bgra[84]=3;bgra[85]=2;bgra[86]=1;bgra[87]=4;
    check(inspect(bgra.data(),bgra.size()).find("\"rgba\":[1,2,3,4")!=std::string::npos,"BGRA swizzle");
    check(inspect_raw(nullptr,0).find("error")!=std::string::npos,"Raw null accepted");
    check(inspect_raw(&tiny,std::numeric_limits<size_t>::max()).find("error")!=std::string::npos,"Raw oversize accepted");
    const auto rawGood=inspect_raw(bc1.data()+56,bc1.size()-56);
    check(rgba(rawGood)==rgba(inspect(bc1.data(),bc1.size())),"Raw and standalone pixels differ");
    check(rawGood.find("PC embedded texture")!=std::string::npos && rawGood.find("\"flags\"")==std::string::npos,"Raw texture falsely claims standalone flags");
    for(size_t field:{0u,4u,8u,12u,16u,24u}){std::vector<unsigned char> bad(bc1.begin()+56,bc1.end());bad[field]^=255;check(inspect_raw(bad.data(),bad.size()).find("error")!=std::string::npos,"Raw malformed descriptor accepted");}
    check(inspect_raw(bc1.data()+56,bc1.size()-57).find("error")!=std::string::npos,"Truncated raw texels accepted");
    const size_t offsets[]={0,8,12,14,15,24,28,30,31,32,48,52,54,55,56,60,64,68,72,80};
    for(size_t offset:offsets){auto bad=bc1;bad[offset]^=0xff;rejects(bad);}
    auto truncated=bc1;truncated.pop_back();rejects(truncated);
    auto trailing=bc1;trailing.push_back(0);rejects(trailing);
    auto tooBig=bc1;set32(tooBig,56,513);rejects(tooBig);
    auto mips=bc1;set32(mips,68,4);rejects(mips);
    auto partial=bc1;set32(partial,56,1);set32(partial,60,1);
    check(inspect(partial.data(),partial.size()).find("\"rgba\":[255,0,0,255]")!=std::string::npos,"Partial edge block cropping");
    auto cube=bc1;set32(cube,80,5);rejects(cube);
    texture_free(nullptr);
    if(argc>1){std::ifstream file(argv[1],std::ios::binary);check(bool(file),"Missing real texture fixture");std::vector<unsigned char> b((std::istreambuf_iterator<char>(file)),{});const auto json=inspect(b.data(),b.size());check(json.find("\"status\":\"ok\"")!=std::string::npos,"Real texture failed");check(json.find("\"width\":128,\"height\":128")!=std::string::npos,"Real arrow dimensions");std::cout<<"Real PC arrow texture decoded 128x128\n";}
    if(argc>2){std::ifstream file(argv[2],std::ios::binary);check(bool(file),"Missing real embedded texture fixture");std::vector<unsigned char> b((std::istreambuf_iterator<char>(file)),{});const auto json=inspect_raw(b.data(),b.size());check(json.find("\"width\":16,\"height\":128")!=std::string::npos,"Real embedded traffic texture dimensions");check(json.find("\"mipLevels\":8")!=std::string::npos,"Real embedded traffic mip chain");std::cout<<"Real embedded trafficcylinder texture decoded 16x128\n";}
    std::cout<<"Texture BC1/BC2/BC3/BGRA known pixels and malformed boundaries passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
