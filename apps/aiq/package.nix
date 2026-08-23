{
  lib,
  pkgs,
  rustPlatform,
}:
rustPlatform.buildRustPackage {
  pname = "aiq";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../Cargo.lock
      ../../Cargo.toml
      ../../rust-toolchain.toml
      ../../apps/aiq
      ../../apps/aiq-runner
      ../../apps/aiq-verifier
    ];
  };

  cargoLock.lockFile = ../../Cargo.lock;
  cargoBuildFlags = [
    "--package"
    "aiq"
    "--locked"
  ];
  cargoTestFlags = [
    "--package"
    "aiq"
    "--locked"
  ];

  # The orchestrator uses this path only to install and reconstruct its sealed
  # source bundle. Frozen worker binaries still receive Git through their
  # explicit launch environment.
  AIQ_BUILD_GIT = "${pkgs.git}/bin/git";

  meta = {
    description = "Reliable orchestration for scheduled AIQ observations";
    mainProgram = "aiq";
    platforms = lib.platforms.darwin;
  };
}
