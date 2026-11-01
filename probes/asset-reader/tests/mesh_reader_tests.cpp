#include "mesh_reader.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void check(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
std::string inspect(const unsigned char* bytes,size_t length) {
    char* result=mesh_inspect(bytes,length);
    check(result!=nullptr,"mesh_inspect returned null");
    std::string json(result);
    mesh_free(result);
    return json;
}
bool has(const std::string& text,const char* needle) { return text.find(needle)!=std::string::npos; }
std::vector<double> array(const std::string& json,const char* name) {
    const std::string key=std::string("\"")+name+"\":[";
    const size_t begin=json.find(key);
    check(begin!=std::string::npos,"Missing JSON array");
    const size_t end=json.find(']',begin+key.size());
    check(end!=std::string::npos,"Unterminated JSON array");
    std::string body=json.substr(begin+key.size(),end-begin-key.size());
    std::replace(body.begin(),body.end(),',',' ');
    std::istringstream stream(body);
    std::vector<double> values;
    double value;
    while(stream>>value) values.push_back(value);
    return values;
}
void fixture_checks(const char* path) {
    std::ifstream stream(path,std::ios::binary);
    check(bool(stream),"Cannot open mesh fixture");
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(stream)),std::istreambuf_iterator<char>());
    const std::string json=inspect(bytes.data(),bytes.size());
    check(has(json,"\"status\":\"ok\""),json.c_str());
    check(has(json,"\"fixtureOnly\":true"),"Fixture restriction must be reported");
    check(has(json,"\"coordinateSpace\":\"object-local\""),"Local coordinates must be reported");
    check(has(json,"\"nodeTransformsApplied\":false"),"Unknown node transforms must be reported");
    check(has(json,"\"triangleCount\":114,"),"Wrong nondegenerate triangle count");
    check(has(json,"\"degenerateTriangleCount\":84,"),"Wrong degenerate triangle count");
    check(has(json,"\"vertexDataOffset\":2846,"),"Wrong Scene-relative vertex alignment");
    check(has(json,"\"indexDataOffset\":4894,"),"Wrong Scene-relative index alignment");
    const auto positions=array(json,"positions"),indices=array(json,"indices");
    check(positions.size()==300,"Expected 100 F32_3 positions");
    check(indices.size()==342,"Expected 114 triangle-list triangles");
    double low[3]={1e9,1e9,1e9},high[3]={-1e9,-1e9,-1e9};
    for(size_t i=0;i<positions.size();++i) {
        check(std::isfinite(positions[i]),"Nonfinite output position");
        low[i%3]=std::min(low[i%3],positions[i]); high[i%3]=std::max(high[i%3],positions[i]);
    }
    const double expected_low[3]={-.0349189639,.00720500434,-.0354576111};
    const double expected_high[3]={.0349190608,.8298954964,.0354576111};
    for(size_t i=0;i<3;++i) {
        check(std::abs(low[i]-expected_low[i])<1e-8,"Wrong local minimum bound");
        check(std::abs(high[i]-expected_high[i])<1e-8,"Wrong local maximum bound");
    }
    for(double index:indices) check(index>=0 && index<100 && std::floor(index)==index,"Out-of-range output index");
    // Every output triangle respects its own source strip's declared vertices.
    for(size_t i=0;i<30;++i) check(indices[i]>=84,"First strip crossed primitive boundary");
    for(size_t i=30;i<indices.size();++i) check(indices[i]<84,"Second strip crossed primitive boundary");
    for(size_t i=0;i<indices.size();i+=3) check(indices[i]!=indices[i+1] && indices[i+1]!=indices[i+2] && indices[i]!=indices[i+2],"Degenerate connector emitted");
    // An unchanged file size/name is insufficient to select an offset profile.
    const size_t mutations[]={0,658,2739,2846,4894,6178,8014};
    for(size_t offset:mutations) {
        bytes[offset]^=1;
        const auto error=inspect(bytes.data(),bytes.size());
        check(has(error,"\"status\":\"error\"") && has(error,"SHA256"),"Modified fixture bypassed identity gate");
        bytes[offset]^=1;
    }
    check(inspect(bytes.data(),bytes.size())==json,"Decoder output is nondeterministic");
    std::cout<<"Actual render fixture: 100 vertices, 114 triangles, bounds and identity checks passed\n";
}
}
int main(int argc,char** argv) {
    try {
        check(has(inspect(nullptr,0),"\"status\":\"error\""),"Null input accepted");
        const unsigned char tiny[4]={' ',' ','C','P'};
        check(has(inspect(tiny,sizeof(tiny)),"\"status\":\"error\""),"Truncated input accepted");
        // Wrong size must be rejected without dereferencing beyond the pointer.
        check(has(inspect(tiny,std::numeric_limits<size_t>::max()),"\"status\":\"error\""),"Oversize input accepted");
        std::vector<unsigned char> fake(8015,0);
        std::copy(tiny,tiny+4,fake.begin());
        check(has(inspect(fake.data(),fake.size()),"SHA256"),"Same-size synthetic input accepted");
        mesh_free(nullptr);
        std::cout<<"Mesh API malformed-input and identity rejection checks passed\n";
        if(argc>1) fixture_checks(argv[1]);
        return EXIT_SUCCESS;
    } catch(const std::exception& error) { std::cerr<<error.what()<<'\n'; return EXIT_FAILURE; }
}
