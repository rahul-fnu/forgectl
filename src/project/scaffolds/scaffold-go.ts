import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export function scaffoldGo(dir: string, name: string, modulePath: string): void {
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

  writeFileSync(
    join(dir, "go.mod"),
    `module ${modulePath}

go 1.22
`,
  );

  writeFileSync(
    join(dir, "main.go"),
    `package main

import (
\t"fmt"
\t"log"
\t"net/http"
)

func helloHandler(w http.ResponseWriter, r *http.Request) {
\tfmt.Fprintln(w, "Hello, world!")
}

func main() {
\thttp.HandleFunc("/", helloHandler)
\tlog.Println("listening on :8080")
\tlog.Fatal(http.ListenAndServe(":8080", nil))
}
`,
  );

  writeFileSync(
    join(dir, "main_test.go"),
    `package main

import (
\t"net/http"
\t"net/http/httptest"
\t"strings"
\t"testing"
)

func TestHelloHandler(t *testing.T) {
\treq := httptest.NewRequest(http.MethodGet, "/", nil)
\trec := httptest.NewRecorder()
\thelloHandler(rec, req)

\tif rec.Code != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", rec.Code)
\t}
\tif !strings.Contains(rec.Body.String(), "Hello, world!") {
\t\tt.Fatalf("unexpected body: %s", rec.Body.String())
\t}
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
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - run: go test ./...
      - uses: golangci/golangci-lint-action@v6
`,
  );

  writeFileSync(
    join(dir, ".gitignore"),
    `${name}
*.exe
*.test
*.out
vendor/
`,
  );
}
