const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildTree } = require("../dist/tree.js");
const entry = (path, root = "/repo") => ({ path, repository: { root } });

test("tree groups nested paths, with folders before files and no redundant repo root", () => {
  const files = [
    entry("z.txt"),
    entry("src/z.ts"),
    entry("src/nested/a.ts"),
    entry("src/a.ts"),
    entry("a.txt"),
  ];
  const tree = buildTree(files);
  assert.deepEqual(
    tree.map((node) => node.name ?? node.path),
    ["src", "a.txt", "z.txt"],
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.name ?? node.path),
    ["nested", "src/a.ts", "src/z.ts"],
  );
  assert.equal(tree[0].children[0].children[0], files[2]);
});

test("tree separates matching paths across repositories", () => {
  const files = [entry("src/a.ts", "/one"), entry("src/a.ts", "/two")];
  const tree = buildTree(files);
  assert.deepEqual(
    tree.map((node) => node.name),
    ["one", "two"],
  );
  assert.equal(tree[0].children[0].children[0], files[0]);
  assert.equal(tree[1].children[0].children[0], files[1]);
});

test("empty input stays empty", () => assert.deepEqual(buildTree([]), []));

test("status sorting groups badges and uses paths to break ties", () => {
  const { compareStatus } = require("../dist/tree.js");
  const files = [
    { path: "a.ts", status: "M", repository: { root: "/repo" } },
    { path: "z.ts", status: "A", repository: { root: "/repo" } },
    { path: "b.ts", status: "M", repository: { root: "/repo" } },
    { path: "nested/deleted.ts", status: "D", repository: { root: "/repo" } },
  ];
  assert.deepEqual(
    [...files].sort(compareStatus).map((file) => file.path),
    ["z.ts", "nested/deleted.ts", "a.ts", "b.ts"],
  );
  const tree = buildTree(files, "status");
  assert.equal(tree[0].name, "nested");
  assert.deepEqual(
    tree.slice(1).map((file) => file.path),
    ["z.ts", "a.ts", "b.ts"],
  );
});
