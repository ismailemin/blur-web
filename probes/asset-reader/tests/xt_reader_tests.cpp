#include "xt_reader.h"
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Bytes=std::vector<unsigned char>;
void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
void u16(Bytes& bytes,uint16_t value){bytes.push_back(uint8_t(value));bytes.push_back(uint8_t(value>>8));}
void u32(Bytes& bytes,uint32_t value){for(int i=0;i<4;i++)bytes.push_back(uint8_t(value>>(8*i)));}
void set32(Bytes& bytes,size_t at,uint32_t value){for(int i=0;i<4;i++)bytes.at(at+i)=uint8_t(value>>(8*i));}
void set16(Bytes& bytes,size_t at,uint16_t value){bytes.at(at)=uint8_t(value);bytes.at(at+1)=uint8_t(value>>8);}
uint32_t get32(const Bytes& bytes,size_t at){return uint32_t(bytes.at(at))|uint32_t(bytes.at(at+1))<<8|uint32_t(bytes.at(at+2))<<16|uint32_t(bytes.at(at+3))<<24;}
void align(Bytes& bytes){while(bytes.size()%4)bytes.push_back(0);}
Bytes fixture(uint32_t version) {
    // Two independent source-shaped schema rows: F32 atom and one-field Object.
    // Every table is emitted from fixed-width integers, without native structs.
    Bytes bytes(72,0);set32(bytes,0,0x464c534b);set32(bytes,4,version);
    const uint32_t widths[]={12,4,8,1,8,16,6,1};
    const uint32_t counts[]={2,0,1,17,1,1,1,4};
    for(int table=0;table<8;table++) {
        align(bytes);set32(bytes,8+table*8,uint32_t(bytes.size()));set32(bytes,12+table*8,counts[table]);
        const auto start=bytes.size();
        switch(table) {
        case 0:{
            const uint16_t rows[]={0,0,0,0,10,4,4,1,0,3,0,4};
            for(uint16_t x:rows)u16(bytes,x);
            break;
        }
        case 1:break;
        case 2:u16(bytes,11);u16(bytes,0);u16(bytes,0);bytes.push_back(0);bytes.push_back(0);break;
        case 3:{const unsigned char names[]={'F','3','2',0,'O','b','j','e','c','t',0,'v','a','l','u','e',0};
            bytes.insert(bytes.end(),names,names+sizeof(names));
            if(version==2){uint8_t previous=0xcc;for(size_t i=0;i<sizeof(names);i++){const uint8_t old=bytes[start+i];bytes[start+i]=uint8_t(previous-old)^0xb3;previous=uint8_t(previous+old-uint32_t(i));}}
            break;}
        case 4:u32(bytes,42);u16(bytes,1);u16(bytes,0);break;
        case 5:u32(bytes,0);u32(bytes,1);u32(bytes,4);u32(bytes,0);break;
        case 6:u16(bytes,1);u16(bytes,1);u16(bytes,0);break;
        case 7:u32(bytes,0x3fa00000);break; // 1.25, kept opaque by metadata reader.
        }
        check(bytes.size()-start==size_t(widths[table])*counts[table],"Test fixture table width mismatch");
    }
    return bytes;
}
std::string inspect(const unsigned char* bytes,size_t count){auto* json=xt_inspect(bytes,count);check(json!=nullptr,"XT result allocation failed");std::string value(json);xt_free(json);return value;}
bool okay(const std::string& value){return value.find("\"status\":\"ok\"")!=std::string::npos;}
bool has(const std::string& value,const char* text){return value.find(text)!=std::string::npos;}
void reject(const Bytes& bytes,const char* message){check(!okay(inspect(bytes.data(),bytes.size())),message);}
}
int main(int argc,char** argv) {
    try {
        check(!okay(inspect(nullptr,0)),"Null accepted");unsigned char tiny[4]={'K','S','L','F'};
        check(!okay(inspect(tiny,std::numeric_limits<size_t>::max())),"Oversize accepted");xt_free(nullptr);
        for(uint32_t version:{1u,2u}) {
            const auto input=fixture(version);const auto result=inspect(input.data(),input.size());check(okay(result),result.c_str());
            check(has(result,"\"name\":\"Object\"")&&has(result,"\"name\":\"value\""),"Plain/encoded schema names incorrect");
            check(has(result,"\"id\":42")&&has(result,"\"componentCount\":1"),"Record metadata incorrect");
            check(has(result,"\"schemaBoundsValidated\":true")&&has(result,"\"recordPayloadValidated\":false")&&has(result,"\"runtimeObjectsCreated\":false"),"Metadata scope flags incorrect");
            for(size_t length=0;length<input.size();length++)check(!okay(inspect(input.data(),length)),"Truncated XT accepted");
            auto payload=input;payload.back()^=1;check(inspect(payload.data(),payload.size())==result,"Metadata reader interpreted opaque record payload");
            check(inspect(input.data(),input.size())==result,"Nondeterministic XT result");
        }
        const auto input=fixture(1);const auto types=get32(input,8),fields=get32(input,24),strings=get32(input,32),refs=get32(input,40),records=get32(input,48),components=get32(input,56);
        auto changed=input;set32(changed,4,99);reject(changed,"Unknown version accepted");
        changed=input;changed[0]='F';reject(changed,"Other endian/tag accepted");
        changed=input;set32(changed,8,73);reject(changed,"Unaligned table accepted");
        changed=input;set32(changed,24,types);reject(changed,"Overlapping table accepted");
        changed=input;set32(changed,12,4097);reject(changed,"Type limit accepted");
        changed=input;set32(changed,64,0xfffffffc);reject(changed,"Overflowing table offset accepted");
        changed=input;set16(changed,types+8,0);reject(changed,"Atom without atom-kind accepted");
        changed=input;set16(changed,types+6,4);reject(changed,"Unknown type behaviour accepted");
        changed=input;set16(changed,types+12+2,0);reject(changed,"Unclaimed field rows accepted");
        changed=input;set16(changed,types+12+4,1);reject(changed,"Out of range base slice accepted");
        changed=input;set16(changed,fields+2,2);reject(changed,"Invalid field type accepted");
        changed=input;set16(changed,fields+4,4);reject(changed,"Field past struct size accepted");
        changed=input;changed[fields+7]=1;reject(changed,"Oversize FlaskArray field accepted");
        changed=input;changed[fields+6]=6;reject(changed,"Label field in struct accepted");
        changed=input;changed[strings+16]='X';reject(changed,"Unterminated schema name accepted");
        changed=input;set32(changed,refs,0);reject(changed,"Unordered/zero ref accepted");
        changed=input;set16(changed,refs+4,2);reject(changed,"Invalid ref type accepted");
        changed=input;set16(changed,refs+6,1);reject(changed,"Invalid ref record accepted");
        changed=input;set32(changed,records+4,0);reject(changed,"Empty record component slice accepted");
        changed=input;set32(changed,records+8,8);reject(changed,"Record size mismatch accepted");
        changed=input;set32(changed,records+12,1);reject(changed,"Record strings outside data accepted");
        changed=input;set16(changed,components,2);reject(changed,"Invalid component type accepted");
        changed=input;set16(changed,components+4,3);reject(changed,"Invalid component behaviour accepted");
        if(argc>1) {
            std::ifstream file(argv[1],std::ios::binary);Bytes real((std::istreambuf_iterator<char>(file)),{});
            const auto result=inspect(real.data(),real.size());check(okay(result),result.c_str());
            check(has(result,"\"format\":\"FLSK\"")&&has(result,"\"inputBytes\":1228"),"Actual vehicle-test fixture mismatch");
        }
        std::cout<<"XT v1/v2 source-shaped fixtures, all truncations, schema/ref/component/data bounds and optional real fixture passed\n";return 0;
    } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
