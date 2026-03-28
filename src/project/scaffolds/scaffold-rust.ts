import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export function scaffoldRust(dir: string, name: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(dir, "Cargo.toml"),
    `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"
`,
  );

  writeFileSync(
    join(dir, "src", "main.rs"),
    `fn main() {
    println!("{}", lib::hello());
}

mod lib;
`,
  );

  writeFileSync(
    join(dir, "src", "lib.rs"),
    `pub fn hello() -> &'static str {
    "Hello, world!"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hello() {
        assert_eq!(hello(), "Hello, world!");
    }
}
`,
  );

  writeFileSync(
    join(dir, ".github", "workflows", "ci.yml"),
    `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - run: cargo test
      - run: cargo clippy -- -D warnings
`,
  );

  writeFileSync(
    join(dir, ".gitignore"),
    `target/
Cargo.lock
`,
  );
}
