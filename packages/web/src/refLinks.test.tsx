import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "./markdown.tsx";
import { ActorLinks } from "./ui.tsx";

/**
 * The wiring card 109 actually ships: a reference in a message becomes an anchor to this
 * board's own hash route, and only inside a board. The grammar itself is tested in
 * `refs.test.ts`; what is asserted here is that the renderer reaches it, resolves the slug
 * from the board in scope, and stays out of the way everywhere else.
 */
const onBoard = (text: string) =>
  renderToStaticMarkup(
    <ActorLinks boardRef="demo">
      <MessageBody text={text} />
    </ActorLinks>,
  );

const offBoard = (text: string) => renderToStaticMarkup(<MessageBody text={text} />);

test("a card reference in a message links to the card's route", () => {
  expect(onBoard("blocked by card 59")).toContain('href="#/b/demo/c/59"');
  expect(onBoard("#59 is next")).toContain('href="#/b/demo/c/59"');
  expect(onBoard("see d8")).toContain('href="#/b/demo/decisions"');
  expect(onBoard("per m194")).toContain('href="#/b/demo/channel"');
});

test("a ref link is an in-app anchor, not a new tab", () => {
  const html = onBoard("card 4");
  expect(html).toContain('class="ref-link"');
  expect(html).not.toContain("target=");
});

test("nothing linkifies outside a board", () => {
  expect(offBoard("card 59 and #12 and d8")).not.toContain("<a");
});

test("code spans and existing links keep their behaviour", () => {
  expect(onBoard("run `flock card show 59`")).not.toContain("ref-link");
  const link = onBoard("[card 59](https://example.com/x)");
  expect(link).toContain('href="https://example.com/x"');
  expect(link).not.toContain("ref-link");
});

test("bullets, bold and quotes still render, now with links inside", () => {
  const html = onBoard("- **card 7** shipped\n- plain");
  expect(html).toContain("<ul>");
  expect(html).toContain("<strong>");
  expect(html).toContain('href="#/b/demo/c/7"');
});
