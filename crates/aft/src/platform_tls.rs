use std::sync::OnceLock;

use rustls::ClientConfig;
use rustls_platform_verifier::ConfigVerifierExt;

static PLATFORM_VERIFIER_CONFIG: OnceLock<Result<ClientConfig, String>> = OnceLock::new();

/// Return the process-wide platform-verifier TLS configuration.
///
/// The configuration is initialized only when the first HTTPS-capable client is
/// built. Cloning it for reqwest is cheap because the verifier and its shared
/// state are reference counted; importantly, native trust decisions remain
/// connection-time work instead of per-client root-store enumeration.
pub(crate) fn client_config() -> Result<ClientConfig, String> {
    PLATFORM_VERIFIER_CONFIG
        .get_or_init(|| {
            // Reqwest enables rustls' ring provider, but does not install a
            // process default provider for callers that supply their own config.
            let _ = rustls::crypto::ring::default_provider().install_default();
            ClientConfig::with_platform_verifier()
                .map_err(|error| format!("failed to create platform TLS verifier: {error}"))
        })
        .clone()
}
