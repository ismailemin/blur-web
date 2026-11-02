/* platform_net_web.cpp - the single network symbol the web build needs.
 *
 * SPIKE ARTIFACT, not engine code.
 *
 * `Network::GetHostName()` lives in system/source/network/Address.cpp, which
 * cannot compile for wasm32 yet (struct in_addr incomplete - 14 errors; the
 * whole network stack is a separate port task). The only consumer on the
 * scheduler path is the log-record field at system/source/debug/log/Logger.cpp:80
 * (`static const Util::C_String sHostName = Network::GetHostName();`).
 *
 * What it returns and why: a fixed, clearly labelled local name. A web build has
 * no host identity - `gethostname()` has no meaning under wasm - so the honest
 * answers are "empty" or "a name that says it is local". Empty would be
 * indistinguishable from a failure and would put an empty field in every log
 * record; "web-local" cannot be mistaken for a resolved machine name. It is NOT
 * a network identity and nothing resolves it.
 */
#include <core/Core.h>
#include <core/containers/String.h>

namespace Network
{

Util::C_String GetHostName()
{
	return Util::C_String( "web-local" );
}

} // namespace Network
