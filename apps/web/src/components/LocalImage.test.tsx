import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./Conversation";
import { LocalImage } from "./LocalImage";

const context = { todoId: "todo", buildId: "build", messageId: "message" };
const create = vi.fn(() => "blob:test-image"), revoke = vi.fn();
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  create.mockClear(); revoke.mockClear();
});
afterEach(() => { delete window.muster; vi.unstubAllGlobals(); });
function desktop() {
  const openPath = vi.fn();
  window.muster = { desktop: true, platform: "darwin", chooseFolder: vi.fn(), openPath, onCommand: vi.fn() };
  return openPath;
}
it.each([false, true])("renders local Markdown images through the task endpoint (desktop=%s)", async (native) => {
  if (native) desktop();
  const fetcher = vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "image/png" })));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<Markdown imageContext={context}>{"![Screenshot](</allowed/artifacts/build/screen.png>)"}</Markdown>);
  expect(await screen.findByAltText("Screenshot")).toHaveAttribute("src", "blob:test-image");
  expect(fetcher).toHaveBeenCalledWith("/api/todos/todo/images", expect.objectContaining({ method: "POST", body: JSON.stringify({ buildId: "build", messageId: "message", src: "/allowed/artifacts/build/screen.png" }) }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "放大图片" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "放大图片" }));
  await user.click(screen.getByRole("button", { name: "关闭对话框" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:test-image");
});
it.each([403, 404, 413, 415, 500])("replaces a failed image (%s) with a path without native or network bypass", async (status) => {
  const openPath = desktop(), fetcher = vi.fn().mockResolvedValue(new Response("", { status })); vi.stubGlobal("fetch", fetcher);
  render(<Markdown imageContext={context}>{"![Shot](/tmp/screen.png)"}</Markdown>);
  expect(await screen.findByText("图片不可用")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "/tmp/screen.png" }));
  expect(screen.getByRole("textbox", { name: "本地图片路径" })).toHaveValue("/tmp/screen.png");
  expect(openPath).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("explains remote images, network failures, and decode errors without broken images", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 409 })).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("bad bytes"));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<LocalImage src="/remote/a.png" context={context} />);
  expect(await screen.findByText("图片不在本机")).toBeInTheDocument();
  view.rerender(<LocalImage src="/remote/b.png" context={context} />);
  expect(await screen.findByText("图片不可用")).toBeInTheDocument();
  view.rerender(<LocalImage src="/remote/c.png" alt="Corrupt" context={context} />);
  fireEvent.error(await screen.findByAltText("Corrupt"));
  expect(screen.getByText("图片不可用")).toBeInTheDocument(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
it("waits for persisted messages and does not fetch images without a task context", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("image")); vi.stubGlobal("fetch", fetcher);
  const view = render(<Markdown>{"![no context](/path.png)"}</Markdown>);
  expect(fetcher).not.toHaveBeenCalled(); expect(screen.queryByRole("img")).not.toBeInTheDocument();
  view.rerender(<Markdown imageContext={{ ...context, streaming: true }}>{"![stream](/path.png)"}</Markdown>);
  expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<Markdown imageContext={context}>{"![stream](/path.png)"}</Markdown>);
  expect(await screen.findByAltText("stream")).toHaveAttribute("src", "blob:test-image");
});
it("aborts stale requests and never creates a URL for an unmounted image", async () => {
  let complete!: (response: Response) => void;
  const fetcher = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; })); vi.stubGlobal("fetch", fetcher);
  const view = render(<LocalImage src="/path.png" context={context} />); view.unmount();
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async () => complete(new Response("image")));
  expect(create).not.toHaveBeenCalled();
});
it("handles file URLs safely in browsers and leaves ordinary HTTPS images intact", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 403 })); vi.stubGlobal("fetch", fetcher);
  render(<Markdown imageContext={context}>{"![local](file:///tmp/shot.png) ![external](https://example.test/image.png)"}</Markdown>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.getByAltText("external")).toHaveAttribute("src", "https://example.test/image.png");
  expect(screen.queryByAltText("local")).not.toBeInTheDocument();
});
it("does not let an enclosing Markdown link bypass image path restrictions", async () => {
  const openPath = desktop(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
  render(<Markdown imageContext={context}>{"[![Shot](/tmp/screen.png)](file:///tmp/screen.png)"}</Markdown>);
  await screen.findByText("图片不可用");
  await userEvent.click(screen.getByRole("button", { name: "/tmp/screen.png" }));
  expect(openPath).not.toHaveBeenCalled();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("displays a readable Unicode path while sending the original Markdown URL", async () => {
  const src = "/artifacts/build/%E6%88%AA%E5%9B%BE%20space.png";
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 404 })); vi.stubGlobal("fetch", fetcher);
  render(<LocalImage src={src} context={context} />);
  await screen.findByText("图片不可用");
  await userEvent.click(screen.getByRole("button", { name: "/artifacts/build/截图 space.png" }));
  expect(screen.getByRole("textbox")).toHaveValue("/artifacts/build/截图 space.png");
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).src).toBe(src);
});
