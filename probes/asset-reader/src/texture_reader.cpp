#include "texture_reader.h"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr uint32_t DXT1=0x31545844, DXT3=0x33545844, DXT5=0x35545844;
struct Reader {
    const unsigned char* b; size_t n;
    void need(size_t p,size_t count) const { if(p>n || count>n-p)throw std::runtime_error("Truncated texture data"); }
    uint16_t u16(size_t p) const {need(p,2);return uint16_t(b[p])|uint16_t(b[p+1])<<8;}
    uint32_t u32(size_t p) const {need(p,4);return uint32_t(b[p])|uint32_t(b[p+1])<<8|uint32_t(b[p+2])<<16|uint32_t(b[p+3])<<24;}
    size_t block(size_t p,size_t end,const char* id,uint8_t type,uint16_t count) const {
        need(p,16);
        const size_t length=u32(p+8);
        if(length<16 || p>end || length>end-p)throw std::runtime_error("Texture block outside parent");
        char expected[8]={};std::memcpy(expected,id,std::strlen(id));
        if(std::memcmp(b+p,expected,8)!=0 || u16(p+12)!=count || b[p+14]!=type || b[p+15]!=0)
            throw std::runtime_error("Unsupported texture block layout or compression");
        return length;
    }
};
using Color=std::array<unsigned char,4>;
Color rgb565(uint16_t value) {
    const unsigned r=value>>11,g=(value>>5)&63,b=value&31;
    return {static_cast<unsigned char>((r<<3)|(r>>2)),static_cast<unsigned char>((g<<2)|(g>>4)),static_cast<unsigned char>((b<<3)|(b>>2)),255};
}
size_t mip_bytes(uint32_t w,uint32_t h,uint32_t format) {
    if(format==DXT1 || format==DXT3 || format==DXT5)return size_t(std::max(1u,(w+3)/4))*std::max(1u,(h+3)/4)*(format==DXT1?8:16);
    if(format==21 || format==22 || format==32 || format==33)return size_t(w)*h*4;
    if(format==28 || format==50)return size_t(w)*h;
    throw std::runtime_error("Unsupported PC texture format");
}
const char* format_name(uint32_t value) {
    switch(value){case DXT1:return "DXT1/BC1";case DXT3:return "DXT3/BC2";case DXT5:return "DXT5/BC3";
        case 21:return "A8R8G8B8";case 22:return "X8R8G8B8";case 32:return "A8B8G8R8";case 33:return "X8B8G8R8";
        case 28:return "A8";case 50:return "L8";default:return "unsupported";}
}
std::vector<unsigned char> pixels(const Reader& r,size_t p,uint32_t width,uint32_t height,uint32_t format) {
    std::vector<unsigned char> out(size_t(width)*height*4);
    if(format!=DXT1 && format!=DXT3 && format!=DXT5){
        for(size_t i=0;i<size_t(width)*height;++i){
            Color c{};
            if(format==28)c={255,255,255,r.b[p+i]};
            else if(format==50)c={r.b[p+i],r.b[p+i],r.b[p+i],255};
            else if(format==21 || format==22)c={r.b[p+i*4+2],r.b[p+i*4+1],r.b[p+i*4],format==21?r.b[p+i*4+3]:static_cast<unsigned char>(255)};
            else c={r.b[p+i*4],r.b[p+i*4+1],r.b[p+i*4+2],format==32?r.b[p+i*4+3]:static_cast<unsigned char>(255)};
            std::copy(c.begin(),c.end(),out.begin()+i*4);
        }
        return out;
    }
    const size_t step=format==DXT1?8:16;
    for(uint32_t by=0;by<(height+3)/4;++by)for(uint32_t bx=0;bx<(width+3)/4;++bx,p+=step){
        const size_t cp=p+(format==DXT1?0:8);
        const uint16_t c0=r.u16(cp),c1=r.u16(cp+2);
        Color palette[4]={rgb565(c0),rgb565(c1),{}, {}};
        if(c0>c1 || format!=DXT1){
            for(int k=0;k<3;++k){palette[2][k]=static_cast<unsigned char>((2*palette[0][k]+palette[1][k])/3);palette[3][k]=static_cast<unsigned char>((palette[0][k]+2*palette[1][k])/3);}
            palette[2][3]=palette[3][3]=255;
        }else{
            for(int k=0;k<3;++k)palette[2][k]=static_cast<unsigned char>((palette[0][k]+palette[1][k])/2);
            palette[2][3]=255;palette[3]={0,0,0,0};
        }
        uint32_t codes=r.u32(cp+4);
        unsigned alpha[8]={}; uint64_t alphaCodes=0;
        if(format==DXT5){
            alpha[0]=r.b[p];alpha[1]=r.b[p+1];
            if(alpha[0]>alpha[1])for(unsigned i=2;i<8;++i)alpha[i]=((8-i)*alpha[0]+(i-1)*alpha[1]+3)/7;
            else{for(unsigned i=2;i<6;++i)alpha[i]=((6-i)*alpha[0]+(i-1)*alpha[1]+2)/5;alpha[6]=0;alpha[7]=255;}
            for(unsigned i=0;i<6;++i)alphaCodes|=uint64_t(r.b[p+2+i])<<(i*8);
        }
        for(unsigned y=0;y<4;++y)for(unsigned x=0;x<4;++x){
            const unsigned pixel=y*4+x;
            Color c=palette[(codes>>(2*pixel))&3];
            if(format==DXT3)c[3]=static_cast<unsigned char>(((r.b[p+pixel/2]>>((pixel%2)*4))&15)*17);
            if(format==DXT5)c[3]=static_cast<unsigned char>(alpha[(alphaCodes>>(3*pixel))&7]);
            const unsigned px=bx*4+x,py=by*4+y;
            if(px<width && py<height)std::copy(c.begin(),c.end(),out.begin()+(size_t(py)*width+px)*4);
        }
    }
    return out;
}
std::string inspect_payload(const Reader& r,size_t desc,size_t payloadBytes,bool standalone,uint32_t flags=0) {
    if(payloadBytes<28)throw std::runtime_error("Truncated PC texture descriptor");
    r.need(desc,payloadBytes);
    const uint32_t width=r.u32(desc),height=r.u32(desc+4),depth=r.u32(desc+8),levels=r.u32(desc+12),format=r.u32(desc+16),usage=r.u32(desc+20),type=r.u32(desc+24);
    if(width==0 || height==0 || width>512 || height>512 || depth!=1 || type!=3 || levels==0 || levels>10)
        throw std::runtime_error("Only 2D PC textures up to 512x512 are supported");
    unsigned maxLevels=1;for(uint32_t side=std::max(width,height);side>1;side>>=1)++maxLevels;
    if(levels>maxLevels)throw std::runtime_error("Too many texture mip levels");
    size_t expected=0;for(uint32_t mip=0;mip<levels;++mip)expected+=mip_bytes(std::max(1u,width>>mip),std::max(1u,height>>mip),format);
    if(expected!=payloadBytes-28)throw std::runtime_error("Texture mip-chain byte count mismatch");
    r.need(desc+28,expected);
    const auto rgba=pixels(r,desc+28,width,height,format);
    std::ostringstream out;
    out<<"{\"status\":\"ok\",\"width\":"<<width<<",\"height\":"<<height<<",\"rgba\":[";
    for(size_t i=0;i<rgba.size();++i){if(i)out<<',';out<<unsigned(rgba[i]);}
    out<<"],\"metadata\":{\"container\":\""<<(standalone?"PC Texture":"PC embedded texture")<<"\",\"format\":\""<<format_name(format)<<"\",\"formatCode\":"<<format
       <<",\"mipLevels\":"<<levels<<",\"displayedMip\":0";
    if(standalone)out<<",\"flags\":"<<flags;
    out<<",\"usage\":"<<usage
       <<",\"pixelDataOffset\":"<<desc+28<<",\"encodedMipChainBytes\":"<<expected<<",\"integrityValidated\":false,\"colorTransformApplied\":false}}";
    return out.str();
}
std::string inspect(const unsigned char* bytes,size_t length) {
    if(!bytes || length<84 || length>8u*1024u*1024u)throw std::runtime_error("Texture input outside 84-byte to 8-MiB limit");
    Reader r{bytes,length};
    if(r.block(0,length,"Texture",0x43,2)!=length)throw std::runtime_error("Trailing texture data");
    const size_t header=r.block(16,length,"Header",0x41,0);
    if(header!=24 || r.u32(32)!=0)throw std::runtime_error("Unsupported texture Header version or size");
    const uint32_t flags=r.u32(36);
    const size_t data=16+header;
    const size_t dataSize=r.block(data,length,"Data",0x41,0);
    if(data+dataSize!=length || dataSize<44)throw std::runtime_error("Invalid texture Data size");
    return inspect_payload(r,data+16,dataSize-16,true,flags);
}
char* copy(const std::string& value){char* out=static_cast<char*>(std::malloc(value.size()+1));if(out)std::memcpy(out,value.c_str(),value.size()+1);return out;}
}
extern "C" char* texture_inspect(const unsigned char* bytes,size_t available){
    try{return copy(inspect(bytes,available));}
    catch(const std::exception& e){return copy(std::string("{\"status\":\"error\",\"error\":\"")+e.what()+"\"}");}
    catch(...){return copy("{\"status\":\"error\",\"error\":\"Texture reader failure\"}");}
}
extern "C" char* texture_raw_inspect(const unsigned char* bytes,size_t available){
    try{
        if(!bytes || available<28 || available>8u*1024u*1024u)throw std::runtime_error("Embedded texture input outside 28-byte to 8-MiB limit");
        return copy(inspect_payload(Reader{bytes,available},0,available,false));
    }
    catch(const std::exception& e){return copy(std::string("{\"status\":\"error\",\"error\":\"")+e.what()+"\"}");}
    catch(...){return copy("{\"status\":\"error\",\"error\":\"Embedded texture reader failure\"}");}
}
extern "C" void texture_free(void* pointer){std::free(pointer);}
