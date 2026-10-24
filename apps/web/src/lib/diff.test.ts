import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

describe("unified diff parser", () => {
  it("counts changes, preserves line numbers, and separates hunks and files", () => {
    const files = parseDiff(`diff --git a/src/a.ts b/src/a.ts
index 123..456 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,2 +2,3 @@ function example
 context
-old
+new
+extra
@@ -10 +11 @@
-before
+after
\\ No newline at end of file
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "src/a.ts", added: 3, removed: 2 });
    expect(
      files[0]?.lines.find((line) => line.text === "+extra"),
    ).toMatchObject({ old: null, next: 4, kind: "add" });
    expect(
      files[0]?.lines.find((line) => line.text === "-before"),
    ).toMatchObject({ old: 10, next: null });
    expect(files[1]).toMatchObject({
      path: "image.png",
      binary: true,
      added: 0,
      removed: 0,
    });
  });
  it("handles added, deleted, renamed, and space-containing paths", () => {
    const files = parseDiff(`diff --git a/hello world.ts b/hello world.ts
new file mode 100644
--- /dev/null
+++ b/hello world.ts
@@ -0,0 +1 @@
++++ literal plus signs
diff --git a/old.ts b/old.ts
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts`);
    expect(files.map((file) => file.path)).toEqual([
      "hello world.ts",
      "old.ts",
      "new name.ts",
    ]);
    expect(files[0]?.added).toBe(1);
    expect(files[1]?.removed).toBe(1);
    expect(files[2]?.previousPath).toBe("old name.ts");
  });
  it("supports plain unified diffs and empty input", () => {
    expect(parseDiff("")).toEqual([]);
    expect(
      parseDiff(
        "--- a/readme.md\r\n+++ b/readme.md\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n",
      )[0],
    ).toMatchObject({ path: "readme.md", added: 1, removed: 1 });
  });
});
