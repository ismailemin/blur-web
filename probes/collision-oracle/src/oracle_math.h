// Scalar re-expression of the Gravity HVec3 operations used by the static
// mesh query paths. No engine header is included and no engine code is linked.
//
// Numeric contract (recorded in the output under scope.numericContract):
//   * every operation is a single binary32 operation, rounded to nearest even;
//   * sqrtf() is the IEEE-754 square root and 1.0f/x is an IEEE division, so
//     Normalise() here is exact, while the retail PC build uses
//     _mm_rsqrt_ps + one Newton-Raphson step (SIMD_SSE.inl:937-939). That
//     difference is documented, not hidden; see README section 6.
//   * minf/maxf follow _mm_min_ps/_mm_max_ps operand ordering (return the
//     second operand when the comparison is unordered).
#pragma once

#include <cmath>
#include <cstdint>

// The native and wasm builds must perform the same binary32 operations in the
// same order. MSVC may contract a*b+c into an FMA under /fp:precise, which
// changes the last bits; the wasm build is compiled with -ffp-contract=off.
#if defined(_MSC_VER)
#pragma fp_contract(off)
#endif
#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#endif

namespace oracle
{
	struct Vec3
	{
		float x, y, z;

		Vec3() : x(0.0f), y(0.0f), z(0.0f) {}
		Vec3(float ax, float ay, float az) : x(ax), y(ay), z(az) {}
	};

	inline Vec3 make_vec3(float x, float y, float z) { return Vec3(x, y, z); }

	inline Vec3 operator+(const Vec3& a, const Vec3& b) { return Vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
	inline Vec3 operator-(const Vec3& a, const Vec3& b) { return Vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
	inline Vec3 operator-(const Vec3& a) { return Vec3(-a.x, -a.y, -a.z); }
	inline Vec3 operator*(const Vec3& a, const Vec3& b) { return Vec3(a.x * b.x, a.y * b.y, a.z * b.z); }
	inline Vec3 operator*(const Vec3& a, float s) { return Vec3(a.x * s, a.y * s, a.z * s); }
	inline Vec3 operator*(float s, const Vec3& a) { return a * s; }
	inline Vec3 operator/(const Vec3& a, const Vec3& b) { return Vec3(a.x / b.x, a.y / b.y, a.z / b.z); }

	inline float dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
	inline Vec3 cross(const Vec3& a, const Vec3& b)
	{
		return Vec3(a.y * b.z - a.z * b.y,
		            a.z * b.x - a.x * b.z,
		            a.x * b.y - a.y * b.x);
	}

	inline Vec3 reciprocal(const Vec3& a) { return Vec3(1.0f / a.x, 1.0f / a.y, 1.0f / a.z); }
	inline Vec3 vabs(const Vec3& a) { return Vec3(std::fabs(a.x), std::fabs(a.y), std::fabs(a.z)); }

	inline float minf(float a, float b) { return (a < b) ? a : b; }
	inline float maxf(float a, float b) { return (a > b) ? a : b; }
	inline float clampf(float v, float lo, float hi) { return maxf(lo, minf(v, hi)); }

	inline Vec3 vmin(const Vec3& a, const Vec3& b) { return Vec3(minf(a.x, b.x), minf(a.y, b.y), minf(a.z, b.z)); }
	inline Vec3 vmax(const Vec3& a, const Vec3& b) { return Vec3(maxf(a.x, b.x), maxf(a.y, b.y), maxf(a.z, b.z)); }

	inline float length_sq(const Vec3& a) { return dot(a, a); }
	inline float length(const Vec3& a) { return std::sqrt(dot(a, a)); }

	// C_Normal(HVec3) -> Normalise(); exact IEEE form here.
	inline Vec3 normalise(const Vec3& a)
	{
		const float len2 = dot(a, a);
		const float inv = 1.0f / std::sqrt(len2);
		return a * inv;
	}

	// Maths::Constants<HF32>::Epsilon() == FLT_EPSILON
	// (core/source/maths/hvec/Constants.cpp.inl:8)
	inline float flt_epsilon() { return 1.1920928955078125e-07f; }
	// Maths::Constants<HF32>::Epsilon2() == 0.01f (same file, :9)
	inline float epsilon2() { return 0.01f; }
	// SharedPhysics::Constants::CloseNormal() == 0.995f
	// (gravity/source/sharedphysics/GravityConstants.cpp:11)
	inline float close_normal() { return 0.995f; }

	// HenDN3 11-11-10 signed normalised decode
	// (core/include/core/maths/hvec/Storage.inl:250-261)
	inline Vec3 decode_hen_dn3(std::uint32_t packed)
	{
		const std::int32_t ex = static_cast<std::int32_t>(packed & 0x7FFu);
		const std::int32_t ey = static_cast<std::int32_t>((packed >> 11) & 0x7FFu);
		const std::int32_t ez = static_cast<std::int32_t>((packed >> 22) & 0x3FFu);
		const float x = static_cast<float>(static_cast<std::int16_t>(ex | ((ex & 0x400) ? 0xF800u : 0u))) / 1023.0f;
		const float y = static_cast<float>(static_cast<std::int16_t>(ey | ((ey & 0x400) ? 0xF800u : 0u))) / 1023.0f;
		const float z = static_cast<float>(static_cast<std::int16_t>(ez | ((ez & 0x200) ? 0xFC00u : 0u))) / 511.0f;
		return Vec3(x, y, z);
	}

	// Fixed3_S16<14> -> HVec3 (core/.../hvec/Vector.inl:1960-1970)
	inline float decode_fixed_s16_14(std::int16_t v)
	{
		const float multiplier = 1.0f / 16384.0f;
		return static_cast<float>(v) * multiplier;
	}

	// HVec3 -> Fixed3_S16<14> (core/.../hvec/Vector.inl:1992-1996)
	inline std::int16_t encode_fixed_s16_14(float v)
	{
		const float multiplier = 16384.0f;
		const float scaled = v * multiplier;
		// C cast to S16: truncate toward zero, then wrap (x86 cvttss2si + movzx).
		if (!(scaled > -2147483648.0f && scaled < 2147483648.0f))
			return static_cast<std::int16_t>(0);
		const std::int32_t trunc = static_cast<std::int32_t>(scaled);
		return static_cast<std::int16_t>(static_cast<std::uint16_t>(trunc));
	}

	// IntersectRayAABBMinMax(p, q, min, max)
	// (gravity/include/gravity/narrowphase/PrimitiveTest.inl:377-408)
	inline bool intersect_ray_aabb(const Vec3& p, const Vec3& q, const Vec3& bmin, const Vec3& bmax)
	{
		const Vec3 zero(0.0f, 0.0f, 0.0f);
		const Vec3 one(1.0f, 1.0f, 1.0f);
		const Vec3 eps(epsilon2(), epsilon2(), epsilon2());

		const Vec3 d = q - p;
		const Vec3 recip_d = reciprocal(d);
		const Vec3 abs_d = vabs(d);

		const bool small_x = abs_d.x < eps.x;
		const bool small_y = abs_d.y < eps.y;
		const bool small_z = abs_d.z < eps.z;

		const bool out_x = (p.x < bmin.x) || (p.x > bmax.x);
		const bool out_y = (p.y < bmin.y) || (p.y > bmax.y);
		const bool out_z = (p.z < bmin.z) || (p.z > bmax.z);

		const bool nohit = (small_x && out_x) || (small_y && out_y) || (small_z && out_z);
		const bool b = !nohit;

		const Vec3 t1_raw = (bmin - p) * recip_d;
		const Vec3 t2_raw = (bmax - p) * recip_d;

		// Select(con1, _t2, _t1) / Select(con1, _t1, _t2) with con1 = _t1 > _t2.
		// Written as explicit conditionals so a NaN operand keeps the same
		// branch as Maths::Select in the engine.
		Vec3 t1, t2;
		{
			const bool c0 = t1_raw.x > t2_raw.x;
			const bool c1 = t1_raw.y > t2_raw.y;
			const bool c2 = t1_raw.z > t2_raw.z;
			t1 = Vec3(c0 ? t2_raw.x : t1_raw.x, c1 ? t2_raw.y : t1_raw.y, c2 ? t2_raw.z : t1_raw.z);
			t2 = Vec3(c0 ? t1_raw.x : t2_raw.x, c1 ? t1_raw.y : t2_raw.y, c2 ? t1_raw.z : t2_raw.z);
		}

		const Vec3 tmin_v = vmax(zero, t1);
		const Vec3 tmax_v = vmin(t2, one);

		const Vec3 new_tmin(small_x ? zero.x : tmin_v.x, small_y ? zero.y : tmin_v.y, small_z ? zero.z : tmin_v.z);
		const Vec3 new_tmax(small_x ? one.x : tmax_v.x, small_y ? one.y : tmax_v.y, small_z ? one.z : tmax_v.z);

		const float tmax = minf(new_tmax.x, minf(new_tmax.y, new_tmax.z));
		const float tmin = maxf(new_tmin.x, maxf(new_tmin.y, new_tmin.z));
		return (tmin < tmax) && b;
	}

	// IntersectTriangleSegmentSB(a,b,c,p,q,res)
	// (gravity/include/gravity/narrowphase/Primitive.inl:520-544)
	inline bool intersect_triangle_segment(const Vec3& a, const Vec3& b, const Vec3& c,
	                                       const Vec3& p, const Vec3& q, Vec3& res)
	{
		const float zero = 0.0f;
		const float one = 1.0f;
		const Vec3 qp = p - q;
		const Vec3 ab = b - a;
		const Vec3 ac = c - a;
		const Vec3 ap = p - a;
		const Vec3 normal = cross(ab, ac);
		const Vec3 e = cross(qp, ap);
		const float d = dot(qp, normal);
		const float recip_d = 1.0f / d;
		const float t = dot(ap, normal) * recip_d;
		const float v = dot(ac, e) * recip_d;
		const float w = dot(-ab, e) * recip_d;
		res = p - qp * t;
		const bool con_d = (d != zero);
		const bool con_t = (t > zero) && (t < one);
		const bool con_v = (v > zero) && (v < one);
		const bool con_w = (w > zero) && ((v + w) < one);
		return con_d && con_t && con_v && con_w;
	}

	// ClosestPtPointTriangle(p,a,b,c,closest)
	// (gravity/source/narrowphase/PrimitiveClosestPointsTest.cpp:493-558)
	inline void closest_point_triangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c, Vec3& closest)
	{
		const float zero = 0.0f;
		const float one = 1.0f;
		const Vec3 ab = b - a;
		const Vec3 ac = c - a;
		const Vec3 ap = p - a;

		const Vec3 n = normalise(cross(ab, ac));
		const float t = dot(n, ap);
		const Vec3 closest_abc = p - n * t;

		const float d00 = dot(ab, ab);
		const float d01 = dot(ab, ac);
		const float d11 = dot(ac, ac);
		const float d20 = dot(ap, ab);
		const float d21 = dot(ap, ac);
		const float demo = d00 * d11 - d01 * d01;
		const float recip_demo = 1.0f / demo;
		const float v = (d11 * d20 - d01 * d21) * recip_demo;
		const float w = (d00 * d21 - d01 * d20) * recip_demo;
		const float u = one - v - w;

		const bool closest_is_inside =
			(v > zero) && (v < one) && (w > zero) && (w < one) && (u > zero) && (u < one);

		const float t0 = clampf(d20 / d00, zero, one);
		const Vec3 closest_ab = a + ab * t0;

		const float t1 = clampf(d21 / d11, zero, one);
		const Vec3 closest_ac = a + ac * t1;

		const Vec3 bc = c - b;
		const float t2 = clampf(dot(p - b, bc) / dot(bc, bc), zero, one);
		const Vec3 closest_bc = b + bc * t2;

		const Vec3 d1 = p - closest_ab;
		const Vec3 d2 = p - closest_ac;
		const Vec3 d3 = p - closest_bc;

		const float sq1 = dot(d1, d1);
		const float sq2 = dot(d2, d2);
		const float sq3 = dot(d3, d3);

		const bool b11 = (sq1 < sq2) && (sq1 < sq3);
		const bool b21 = (sq2 < sq3);

		if (closest_is_inside)
			closest = closest_abc;
		else if (b11)
			closest = closest_ab;
		else if (b21)
			closest = closest_ac;
		else
			closest = closest_bc;
	}

	// C_AxisBoxMinMax::Intersects(const C_CRAxisBox&)
	// (gravity/include/gravity/narrowphase/AxisBox.inl:76-88)
	struct AxisBoxMinMax
	{
		Vec3 min;
		Vec3 max;
	};

	struct CRAxisBox
	{
		Vec3 centre;
		Vec3 extents;
	};

	inline bool box_intersects_minmax(const AxisBoxMinMax& box, const CRAxisBox& other)
	{
		const Vec3 other_max = other.centre + other.extents;
		const Vec3 other_min = other.centre - other.extents;
		return (other_max.x >= box.min.x && other_max.y >= box.min.y && other_max.z >= box.min.z) &&
		       (other_min.x <= box.max.x && other_min.y <= box.max.y && other_min.z <= box.max.z);
	}

	// IntersectAABBTriangle(box, a, b, c)
	// (gravity/include/gravity/narrowphase/OptimisedAABBTree_FillCache.inl:12-85)
	inline bool intersect_aabb_triangle(const CRAxisBox& box, const Vec3& a, const Vec3& b, const Vec3& c)
	{
		const Vec3 ca = box.centre;
		const Vec3 e = box.extents;

		const Vec3 v0 = a - ca;
		const Vec3 v1 = b - ca;
		const Vec3 v2 = c - ca;

		const Vec3 f0 = v1 - v0;
		const Vec3 f1 = v2 - v1;
		const Vec3 f2 = v0 - v2;

		const Vec3 abs_f0 = vabs(f0);
		const Vec3 cross_p00 = cross(v0, f0);
		const Vec3 cross_p01 = cross(v2, f0);
		const Vec3 cross_ra0(e.y * abs_f0.z + e.z * abs_f0.y,
		                     e.x * abs_f0.z + e.z * abs_f0.x,
		                     e.x * abs_f0.y + e.y * abs_f0.x);
		const Vec3 vmin0 = vmin(cross_p00, cross_p01);
		const Vec3 vmax0 = vmax(cross_p00, cross_p01);
		if ((vmax0.x < -cross_ra0.x) || (vmax0.y < -cross_ra0.y) || (vmax0.z < -cross_ra0.z) ||
		    (vmin0.x > cross_ra0.x) || (vmin0.y > cross_ra0.y) || (vmin0.z > cross_ra0.z))
			return false;

		const Vec3 abs_f1 = vabs(f1);
		const Vec3 cross_p10 = cross(v0, f1);
		const Vec3 cross_p11 = cross(v1, f1);
		const Vec3 cross_ra1(e.y * abs_f1.z + e.z * abs_f1.y,
		                     e.x * abs_f1.z + e.z * abs_f1.x,
		                     e.x * abs_f1.y + e.y * abs_f1.x);
		const Vec3 vmax1 = vmax(cross_p10, cross_p11);
		const Vec3 vmin1 = vmin(cross_p10, cross_p11);
		if ((vmax1.x < -cross_ra1.x) || (vmax1.y < -cross_ra1.y) || (vmax1.z < -cross_ra1.z) ||
		    (vmin1.x > cross_ra1.x) || (vmin1.y > cross_ra1.y) || (vmin1.z > cross_ra1.z))
			return false;

		const Vec3 abs_f2 = vabs(f2);
		const Vec3 cross_p20 = cross(v0, f2);
		const Vec3 cross_p21 = cross(v1, f2);
		const Vec3 vmax2 = vmax(cross_p20, cross_p21);
		const Vec3 vmin2 = vmin(cross_p20, cross_p21);
		const Vec3 cross_ra2(e.y * abs_f2.z + e.z * abs_f2.y,
		                     e.x * abs_f2.z + e.z * abs_f2.x,
		                     e.x * abs_f2.y + e.y * abs_f2.x);
		if ((vmax2.x < -cross_ra2.x) || (vmax2.y < -cross_ra2.y) || (vmax2.z < -cross_ra2.z) ||
		    (vmin2.x > cross_ra2.x) || (vmin2.y > cross_ra2.y) || (vmin2.z > cross_ra2.z))
			return false;

		const Vec3 n = cross(f0, f1);
		const float d = dot(n, v0);
		const Vec3 abs_n = vabs(n);
		const float r = dot(e, abs_n);
		return std::fabs(d) <= r;
	}
}
