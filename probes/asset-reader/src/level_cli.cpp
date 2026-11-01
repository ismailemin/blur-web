#include "scene_reader.h"
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

std::vector<unsigned char> read(const char* path) {
    std::ifstream input(path,std::ios::binary|std::ios::ate);
    if(!input||input.tellg()<0||input.tellg()>64*1024*1024)throw std::runtime_error("Cannot read input or input exceeds 64 MiB");
    const auto size=static_cast<size_t>(input.tellg());input.seekg(0);
    std::vector<unsigned char> data(size);
    if(size&&!input.read(reinterpret_cast<char*>(data.data()),static_cast<std::streamsize>(size)))throw std::runtime_error("Short file read");
    return data;
}
int32_t block(const char* value){size_t used=0;const auto result=std::stoll(value,&used);if(value[used]||result<0||result>100000)throw std::runtime_error("Invalid resource block ID");return static_cast<int32_t>(result);}
int main(int argc,char**argv){
    try{
        char* output=nullptr;
        if(argc==3&&std::string(argv[1])=="--index"){
            const auto level=read(argv[2]);output=level_index_inspect(level.data(),level.size());
        }else if(argc==7&&std::string(argv[1])=="--instances"){
            const auto level=read(argv[2]),geometry=read(argv[3]),node=read(argv[4]);
            output=level_instances_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),block(argv[5]),block(argv[6]));
        }else if(argc==7&&std::string(argv[1])=="--instances-all"){
            const auto level=read(argv[2]),geometry=read(argv[3]),node=read(argv[4]);
            output=level_instances_all_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),block(argv[5]),block(argv[6]));
        }else if(argc==6){
            const auto level=read(argv[1]),geometry=read(argv[2]),node=read(argv[3]);
            output=level_mesh_inspect(level.data(),level.size(),geometry.data(),geometry.size(),node.data(),node.size(),block(argv[4]),block(argv[5]));
        }else{std::cerr<<"Usage: level_inspect --index levelrender | levelrender geometry-chunk node-chunk geometry-block node-block | --instances|--instances-all levelrender geometry-chunk node-chunk geometry-block node-block\n";return 2;}
        if(!output)return 3;const std::string json(output);scene_free(output);std::cout<<json<<'\n';
        return json.find("\"status\":\"ok\"")!=std::string::npos?0:1;
    }catch(const std::exception&error){std::cerr<<error.what()<<'\n';return 2;}
}
