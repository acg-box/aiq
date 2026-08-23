//! Shipped-binary coverage for create-only unattended provider setup.

#![cfg(unix)]

use std::env;
use std::{
	fs::{self, Permissions},
	io::{ErrorKind, Read as _, Write as _},
	net::TcpListener,
	os::unix::fs::PermissionsExt as _,
	path::{Path, PathBuf},
	process::{self, Command},
	sync::atomic::{AtomicU64, Ordering},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use aiq as _;
use clap as _;
use hex as _;
use jiff as _;
use libc as _;
use serde as _;
use serde_json::Value;
use sha2 as _;
use ureq as _;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
	root: PathBuf,
	home: PathBuf,
	state: PathBuf,
	timeout: PathBuf,
	security: PathBuf,
	infisical: PathBuf,
	configuration: PathBuf,
	keychain_state: PathBuf,
	provider_log: PathBuf,
	outside_repository: PathBuf,
}
impl Fixture {
	fn new(api_url: &str) -> Self {
		let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
		let root =
			env::temp_dir().join(format!("aiq-provision-contract-{}-{sequence}", process::id(),));
		let _ = fs::remove_dir_all(&root);
		let home = root.join("home");
		let state = root.join("state");
		let bin = root.join("bin");
		let outside_repository = root.join("outside-repository");
		let configuration = root.join("provider.json");
		let keychain_state = root.join("keychain-secret");
		let provider_log = root.join("provider.log");

		for path in [&root, &home, &bin, &outside_repository] {
			fs::create_dir_all(path).expect("fixture directory");
			fs::set_permissions(path, Permissions::from_mode(0o700)).expect("fixture mode");
		}

		let timeout = bin.join("timeout");
		let security = bin.join("security");
		let infisical = bin.join("infisical");

		write_script(&timeout, "shift 3\nexec \"$@\"\n");
		write_security_script(&security, &keychain_state);
		write_infisical_script(&infisical, &state, &provider_log);

		fs::write(
			&configuration,
			serde_json::to_vec_pretty(&serde_json::json!({
				"schema_version": "aiq.unattended-provider-provision.v1",
				"state_root": state,
				"infisical_executable": infisical,
				"timeout_executable": timeout,
				"security_executable": security,
				"api_url": api_url,
				"project_id": "project-id",
				"keychain_service": "infisical-selfhost",
				"keychain_account": "AIQ_OBSERVATION_UA_CLIENT_SECRET",
				"admin_keychain_account": "INSTANCE_ADMIN_TOKEN",
				"identity_name": "aiq-continuous-observation-host",
				"privilege_slug": "aiq-continuous-observation-read",
				"environment": "prod",
				"path": "/aiq",
				"selectors": {
					"runner_signing_key": "RUNNER_SIGNING_KEY",
					"runner_submission_token": "RUNNER_SUBMISSION_TOKEN",
					"verifier_ingress_token": "VERIFIER_INGRESS_TOKEN",
					"verifier_signing_key": "VERIFIER_SIGNING_KEY"
				}
			}))
			.expect("provider configuration"),
		)
		.expect("write provider configuration");
		fs::set_permissions(&configuration, Permissions::from_mode(0o600))
			.expect("provider configuration mode");

		Self {
			root,
			home,
			state,
			timeout,
			security,
			infisical,
			configuration,
			keychain_state,
			provider_log,
			outside_repository,
		}
	}

	fn command(&self) -> Command {
		let mut command = Command::new(env!("CARGO_BIN_EXE_aiq"));

		command
			.args(["operator", "provision-unattended", "--config"])
			.arg(&self.configuration)
			.current_dir(&self.outside_repository)
			.env_clear()
			.env("HOME", &self.home)
			.env("LOGNAME", "aiq-test")
			.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
			.env("USER", "aiq-test");

		command
	}
}
impl Drop for Fixture {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

#[test]
fn existing_keychain_target_refuses_setup_before_provider_access() {
	let listener = TcpListener::bind("127.0.0.1:0").expect("provider listener");
	let api_url = format!("http://{}", listener.local_addr().expect("provider address"));
	let fixture = Fixture::new(&api_url);

	fs::write(&fixture.keychain_state, b"already-present").expect("occupied Keychain state");

	let output = fixture.command().output().expect("operator setup output");

	assert!(!output.status.success());
	assert_eq!(
		String::from_utf8_lossy(&output.stderr),
		"aiq: AIQ Universal Auth Keychain account already exists; create-only setup refused\n",
	);
	assert!(!fixture.provider_log.exists());

	listener.set_nonblocking(true).expect("nonblocking listener");

	assert!(listener.accept().is_err_and(|error| error.kind() == ErrorKind::WouldBlock));
}

#[test]
fn controlled_provider_setup_commits_exact_target_and_cleans_session() {
	let (api_url, server) = serve(provider_responses());
	let fixture = Fixture::new(&api_url);
	let output = fixture.command().output().expect("operator setup output");
	let requests = server.join().expect("provider server");

	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	assert!(output.stderr.is_empty());

	let receipt: Value = serde_json::from_slice(&output.stdout).expect("setup receipt");

	assert_eq!(receipt.get("status").and_then(Value::as_str), Some("succeeded"));
	assert_eq!(
		receipt.pointer("/identity/clientId").and_then(Value::as_str),
		Some("generated-client-id")
	);
	assert!(!String::from_utf8_lossy(&output.stdout).contains("bootstrap-sentinel"));
	assert_eq!(
		fs::read_to_string(&fixture.provider_log).expect("provider selector log"),
		"RUNNER_SIGNING_KEY\nRUNNER_SUBMISSION_TOKEN\nVERIFIER_INGRESS_TOKEN\nVERIFIER_SIGNING_KEY\n",
	);
	assert_eq!(fs::read(&fixture.keychain_state).expect("Keychain state"), b"bootstrap-sentinel");
	assert!(!fixture.state.join("provider/session").exists());
	assert_eq!(requests, expected_requests());

	for executable in [&fixture.timeout, &fixture.security, &fixture.infisical] {
		assert!(executable.exists());
	}
}

fn write_security_script(path: &Path, state: &Path) {
	write_script(
		path,
		&format!(
			r#"case "$1" in
  find-generic-password)
    [ "$2" = "-s" ]
    [ "$3" = "infisical-selfhost" ]
    [ "$4" = "-a" ]
    [ "$6" = "-w" ]
    case "$5" in
      INSTANCE_ADMIN_TOKEN) printf '%s\n' admin-token-sentinel ;;
      AIQ_OBSERVATION_UA_CLIENT_SECRET)
        [ -f {state} ] || exit 44
        cat {state}
        printf '\n'
        ;;
      *) exit 80 ;;
    esac
    ;;
  add-generic-password)
    [ "$2" = "-A" ]
    [ "$3" = "-s" ]
    [ "$4" = "infisical-selfhost" ]
    [ "$5" = "-a" ]
    [ "$6" = "AIQ_OBSERVATION_UA_CLIENT_SECRET" ]
    [ "$7" = "-w" ]
    IFS= read -r first
    IFS= read -r second
    [ "$first" = "$second" ]
    printf %s "$first" >{state}
    ;;
  *) exit 81 ;;
esac
"#,
			state = shell_quote(state),
		),
	);
}

fn write_infisical_script(path: &Path, state: &Path, log: &Path) {
	write_script(
		path,
		&format!(
			r#"[ "$#" -eq 14 ]
[ "$1" = "secrets" ]
[ "$2" = "get" ]
[ "$4" = "--silent" ]
[ "$5" = "--domain=${{INFISICAL_DOMAIN}}" ]
[ "$6" = "--projectId=project-id" ]
[ "$7" = "--env=prod" ]
[ "$8" = "--path=/aiq" ]
[ "$9" = "--plain" ]
[ "${{10}}" = "--expand=false" ]
[ "${{11}}" = "--include-imports=false" ]
[ "${{12}}" = "--recursive=false" ]
[ "${{13}}" = "--secret-overriding=false" ]
[ "${{14}}" = "--telemetry=false" ]
[ "$INFISICAL_TOKEN" = "access-token-sentinel" ]
[ -z "${{INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET+x}}" ]
case "$HOME" in
  {state}/provider/session) ;;
  *) exit 82 ;;
esac
printf '%s\n' "$3" >>{log}
case "$3" in
  RUNNER_SIGNING_KEY) printf '%s\n' runner-signing-sentinel ;;
  RUNNER_SUBMISSION_TOKEN) printf '%s\n' runner-submission-sentinel ;;
  VERIFIER_INGRESS_TOKEN) printf '%s\n' verifier-ingress-sentinel ;;
  VERIFIER_SIGNING_KEY) printf '%s\n' verifier-signing-sentinel ;;
  *) exit 83 ;;
esac
"#,
			state = shell_quote(state),
			log = shell_quote(log),
		),
	);
}

fn write_script(path: &Path, body: &str) {
	fs::write(path, format!("#!/bin/sh\nset -eu\n{body}")).expect("fixture script");
	fs::set_permissions(path, Permissions::from_mode(0o700)).expect("fixture script mode");
}

fn shell_quote(path: &Path) -> String {
	format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

fn provider_responses() -> Vec<String> {
	let permissions = serde_json::json!([{
		"subject": "secrets",
		"action": ["describeSecret", "readValue"],
		"conditions": {
			"environment": {"$eq": "prod"},
			"secretPath": {"$eq": "/aiq"},
			"secretName": {"$in": [
				"RUNNER_SIGNING_KEY",
				"RUNNER_SUBMISSION_TOKEN",
				"VERIFIER_INGRESS_TOKEN",
				"VERIFIER_SIGNING_KEY"
			]}
		}
	}]);

	vec![
		serde_json::json!({"project":{"id":"project-id","environments":[{"slug":"prod"}]}}),
		serde_json::json!({"identities":[]}),
		serde_json::json!({"identity":{"id":"identity-id"}}),
		serde_json::json!({"identityMembership":{"roles":[{"role":"no-access","isTemporary":false,"customRoleId":null}]}}),
		serde_json::json!({"privilege":{"id":"privilege-id"}}),
		serde_json::json!({"privileges":[{"id":"privilege-id","slug":"aiq-continuous-observation-read"}]}),
		serde_json::json!({"privilege":{"slug":"aiq-continuous-observation-read","isTemporary":false,"permissions":permissions}}),
		serde_json::json!({"identityUniversalAuth":{"clientId":"generated-client-id"}}),
		serde_json::json!({"clientSecretData":{"id":"client-secret-id"},"clientSecret":"bootstrap-sentinel"}),
		serde_json::json!({"accessToken":"access-token-sentinel"}),
	]
	.into_iter()
	.map(|value| serde_json::to_string(&value).expect("provider response"))
	.collect()
}

fn expected_requests() -> Vec<&'static str> {
	vec![
		"GET /api/v1/projects/project-id HTTP/1.1",
		"GET /api/v1/projects/project-id/identities?limit=1000 HTTP/1.1",
		"POST /api/v1/projects/project-id/identities HTTP/1.1",
		"GET /api/v1/projects/project-id/memberships/identities/identity-id HTTP/1.1",
		"POST /api/v2/identity-project-additional-privilege HTTP/1.1",
		"GET /api/v2/identity-project-additional-privilege?identityId=identity-id&projectId=project-id HTTP/1.1",
		"GET /api/v2/identity-project-additional-privilege/privilege-id HTTP/1.1",
		"POST /api/v1/auth/universal-auth/identities/identity-id HTTP/1.1",
		"POST /api/v1/auth/universal-auth/identities/identity-id/client-secrets HTTP/1.1",
		"POST /api/v1/auth/universal-auth/login HTTP/1.1",
	]
}

fn serve(responses: Vec<String>) -> (String, JoinHandle<Vec<String>>) {
	let listener = TcpListener::bind("127.0.0.1:0").expect("provider listener");
	let address = listener.local_addr().expect("provider address");

	listener.set_nonblocking(true).expect("nonblocking provider listener");

	let server = thread::spawn(move || {
		responses.into_iter().map(|response| serve_one(&listener, &response)).collect()
	});

	(format!("http://{address}"), server)
}

fn serve_one(listener: &TcpListener, response: &str) -> String {
	let deadline = Instant::now() + Duration::from_secs(5);
	let mut stream = loop {
		match listener.accept() {
			Ok((stream, _)) => break stream,
			Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
				thread::sleep(Duration::from_millis(5));
			},
			Err(error) => panic!("cannot accept provider request: {error}"),
		}
	};

	stream.set_nonblocking(false).expect("blocking provider stream");
	stream.set_read_timeout(Some(Duration::from_secs(5))).expect("provider read timeout");

	let mut request = Vec::new();
	let mut byte = [0_u8; 1];

	while !request.ends_with(b"\r\n\r\n") {
		stream.read_exact(&mut byte).expect("provider request header");
		request.push(byte[0]);
	}

	let header = String::from_utf8(request).expect("provider request UTF-8");
	let content_length = header
		.lines()
		.find_map(|line| {
			let (name, value) = line.split_once(':')?;

			name.eq_ignore_ascii_case("content-length").then(|| value.trim())
		})
		.map(|value| value.parse::<usize>().expect("content length"))
		.unwrap_or(0);
	let mut body = vec![0_u8; content_length];

	stream.read_exact(&mut body).expect("provider request body");
	stream
		.write_all(
			format!(
				"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
				response.len(),
			)
			.as_bytes(),
		)
		.expect("provider response");

	header.lines().next().expect("request line").to_owned()
}
