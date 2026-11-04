#ifndef STREAM_SPIKE_FX_FX_H
#define STREAM_SPIKE_FX_FX_H
// Probe-only FX facade. The streaming layer stores FX::Effect*, never calls it.
#include <Core/Core.h>
#include <btl/containers/bitvector.h>

namespace FX
{
    class I_Effect {};
    class Effect {};
    typedef U64 ImmediateParameter;
    typedef Btl::BitVectorTemplate<Btl::BitArrayBase<Btl::Vector<U32, Btl::VectorParameters_Array<4> > > > SharedBindingBits;
}
#endif
