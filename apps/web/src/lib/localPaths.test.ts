import { describe, expect, it } from "vitest";
import { absolutePath, localPathLinks, localPathUrl } from "./localPaths";
describe("desktop conversation paths", () => {
  it("recognizes Unix, Windows and escaped file links without accepting remote URLs", () => {
    for (const path of ["/Users/me/My Repo", "C:\\Users\\me\\repo"]) expect(absolutePath(localPathUrl(path))).toBe(path);
    expect(absolutePath("file:///Users/me/My%20Repo")).toBe("/Users/me/My Repo");
    expect(absolutePath("https://example.com/path")).toBeNull();
    expect(absolutePath("file://remote/share")).toBeNull();
    expect(absolutePath("javascript:alert(1)")).toBeNull();
  });
  it("links bare paths but preserves URLs and code", () => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "Open /Users/me/repo, then https://example.com/path" }] }, { type: "code", value: "cat /Users/me/repo" }] };
    localPathLinks()(tree);
    expect(JSON.stringify(tree)).toContain(localPathUrl("/Users/me/repo"));
    expect(JSON.stringify(tree)).not.toContain(localPathUrl("/example.com/path"));
    expect(tree.children[1]?.value).toBe("cat /Users/me/repo");
  });
});
