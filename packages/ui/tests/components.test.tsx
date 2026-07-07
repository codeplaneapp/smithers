import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  composeSmithersUiStyles,
  EmptyState,
  Eyebrow,
  Field,
  Input,
  KpiStat,
  Label,
  Progress,
  RowButton,
  SectionHeader,
  Separator,
  Skeleton,
  SmithersUiStyles,
  smithersUiCss,
  Spinner,
  StatusPill,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../src/index";

/**
 * Pure-markup tests rendered with `renderToStaticMarkup` (no DOM), the
 * gateway-ui convention. Radix open/close/focus behavior is covered by
 * tests/radix-interaction.test.tsx under happy-dom.
 */
describe("Button", () => {
  test("renders the house tinted primary by default with type=button", () => {
    const html = renderToStaticMarkup(<Button>Launch</Button>);
    expect(html).toContain("sui-button");
    expect(html).toContain("sui-button-default");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("Launch");
  });

  test("maps variants and sizes to namespaced classes", () => {
    expect(renderToStaticMarkup(<Button variant="solid">x</Button>)).toContain("sui-button-solid");
    expect(renderToStaticMarkup(<Button variant="destructive">x</Button>)).toContain("sui-button-destructive");
    expect(renderToStaticMarkup(<Button variant="ghost">x</Button>)).toContain("sui-button-ghost");
    expect(renderToStaticMarkup(<Button size="icon">x</Button>)).toContain("sui-button-icon-size");
    expect(renderToStaticMarkup(<Button size="sm">x</Button>)).toContain("sui-button-sm");
  });

  test("asChild renders the child element with button classes (Radix Slot)", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/runs/123">Open run</a>
      </Button>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/runs/123"');
    expect(html).toContain("sui-button");
    expect(html).not.toContain("<button");
  });

  test("keeps consumer className and explicit submit type", () => {
    const html = renderToStaticMarkup(<Button type="submit" className="my-extra">x</Button>);
    expect(html).toContain('type="submit"');
    expect(html).toContain("my-extra");
  });
});

describe("Badge + StatusPill", () => {
  test("badge defaults to the brand pill and supports status variants", () => {
    expect(renderToStaticMarkup(<Badge>hi</Badge>)).toContain("sui-badge-default");
    expect(renderToStaticMarkup(<Badge variant="success">hi</Badge>)).toContain("sui-badge-success");
    expect(renderToStaticMarkup(<Badge variant="muted">hi</Badge>)).toContain("sui-badge-muted");
  });

  test("StatusPill maps status buckets onto badge variants with data-status", () => {
    const running = renderToStaticMarkup(<StatusPill status="running" />);
    expect(running).toContain("sui-badge-warning");
    expect(running).toContain('data-status="running"');
    expect(running).toContain("Running");
    expect(running).toContain("sui-status-dot");

    expect(renderToStaticMarkup(<StatusPill status="ok" />)).toContain("sui-badge-success");
    expect(renderToStaticMarkup(<StatusPill status="failed" />)).toContain("sui-badge-destructive");
    expect(renderToStaticMarkup(<StatusPill status="cancelled" />)).toContain("sui-badge-muted");
    expect(renderToStaticMarkup(<StatusPill status="waiting_approval" />)).toContain("Waiting for approval");
  });

  test("StatusPill honors label override and withDot=false", () => {
    const html = renderToStaticMarkup(<StatusPill status="ok" label="Done" withDot={false} />);
    expect(html).toContain("Done");
    expect(html).not.toContain("sui-status-dot");
  });
});

describe("Card", () => {
  test("composes header/title/action/content slots", () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardAction>
            <Badge variant="secondary">3</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    );
    expect(html).toContain("sui-card");
    expect(html).toContain("sui-card-header");
    expect(html).toContain("sui-card-title");
    expect(html).toContain("sui-card-action");
    expect(html).toContain("sui-card-content");
    expect(html).toContain('data-slot="card"');
  });

  test("renders the description and footer slots", () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
          <CardDescription>Recent activity</CardDescription>
        </CardHeader>
        <CardFooter>footer text</CardFooter>
      </Card>,
    );
    expect(html).toContain("sui-card-description");
    expect(html).toContain('data-slot="card-description"');
    expect(html).toContain("Recent activity");
    expect(html).toContain("sui-card-footer");
    expect(html).toContain('data-slot="card-footer"');
    expect(html).toContain("footer text");
  });
});

describe("form controls", () => {
  test("Input/Textarea/Label/Field carry the sui classes", () => {
    const html = renderToStaticMarkup(
      <Field>
        <Label htmlFor="p">Prompt</Label>
        <Input id="p" placeholder="Describe the task" />
        <Textarea placeholder="More" />
      </Field>,
    );
    expect(html).toContain("sui-field");
    expect(html).toContain("sui-label");
    expect(html).toContain('for="p"');
    expect(html).toContain("sui-input");
    expect(html).toContain("sui-textarea");
  });
});

describe("Alert", () => {
  test("renders role=alert with variant classes", () => {
    const html = renderToStaticMarkup(
      <Alert variant="warning">
        <AlertTitle>Gateway not connected</AlertTitle>
        <AlertDescription>Runs cannot be launched from this deployment.</AlertDescription>
      </Alert>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("sui-alert-warning");
    expect(html).toContain("sui-alert-title");
    expect(html).toContain("sui-alert-description");
  });
});

describe("Table", () => {
  test("wraps the table in an overflow container", () => {
    const html = renderToStaticMarkup(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>abc123</TableCell>
          </TableRow>
        </TableBody>
        <TableCaption>All runs</TableCaption>
      </Table>,
    );
    expect(html).toContain("sui-table-container");
    expect(html).toContain("sui-table");
    expect(html).toContain("<thead");
    expect(html).toContain("abc123");
    expect(html).toContain("<caption");
    expect(html).toContain('data-slot="table-caption"');
    expect(html).toContain("All runs");
  });
});

describe("Tabs", () => {
  test("renders triggers with count pills and the active content", () => {
    const html = renderToStaticMarkup(
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs" count={12}>
            Runs
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">run list</TabsContent>
        <TabsContent value="events">event list</TabsContent>
      </Tabs>,
    );
    expect(html).toContain("sui-tabs-list");
    expect(html).toContain("sui-tabs-trigger");
    expect(html).toContain("sui-tab-count");
    expect(html).toContain(">12<");
    expect(html).toContain("run list");
    expect(html).not.toContain("event list");
  });
});

describe("misc primitives", () => {
  test("Spinner announces status; Skeleton is aria-hidden", () => {
    const spinner = renderToStaticMarkup(<Spinner />);
    expect(spinner).toContain('role="status"');
    expect(spinner).toContain("sui-spinner");
    const skeleton = renderToStaticMarkup(<Skeleton style={{ width: 120 }} />);
    expect(skeleton).toContain("sui-skeleton");
    expect(skeleton).toContain("aria-hidden");
  });

  test("Progress carries value semantics and the translated indicator", () => {
    const html = renderToStaticMarkup(<Progress value={40} />);
    expect(html).toContain("sui-progress");
    expect(html).toContain("sui-progress-indicator");
    expect(html).toContain("translateX(-60%)");
  });

  test("Separator renders orientation data attributes", () => {
    expect(renderToStaticMarkup(<Separator />)).toContain('data-orientation="horizontal"');
    expect(renderToStaticMarkup(<Separator orientation="vertical" />)).toContain('data-orientation="vertical"');
  });

  test("EmptyState renders optional slots", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No runs yet" description="Launch one to see it here." action={<Button>Launch</Button>} />,
    );
    expect(html).toContain("sui-empty");
    expect(html).toContain("No runs yet");
    expect(html).toContain("sui-empty-action");
  });

  test("SectionHeader composes eyebrow, title, and actions", () => {
    const html = renderToStaticMarkup(
      <SectionHeader eyebrow="Workflow" title="Implement" actions={<Button size="sm">Refresh</Button>} />,
    );
    expect(html).toContain("sui-eyebrow");
    expect(html).toContain("sui-section-header-title");
    expect(html).toContain("sui-section-header-actions");
    expect(renderToStaticMarkup(<Eyebrow>Docs</Eyebrow>)).toContain("sui-eyebrow");
  });

  test("RowButton reflects the active state", () => {
    const active = renderToStaticMarkup(<RowButton active>row</RowButton>);
    expect(active).toContain('data-active="true"');
    const idle = renderToStaticMarkup(<RowButton>row</RowButton>);
    expect(idle).not.toContain("data-active");
  });

  test("KpiStat renders label/value/hint", () => {
    const html = renderToStaticMarkup(<KpiStat label="Total runs" value={42} hint="last 7 days" />);
    expect(html).toContain("sui-kpi-label");
    expect(html).toContain("sui-kpi-value");
    expect(html).toContain("sui-kpi-hint");
  });
});

describe("SmithersUiStyles", () => {
  test("renders the marker style tag with the component sheet", () => {
    const html = renderToStaticMarkup(<SmithersUiStyles />);
    expect(html).toContain("data-smithers-ui");
    expect(html).toContain(".sui-button");
    expect(html).toContain(".sui-card");
  });

  test("withTheme prepends the styleguide theme tokens for standalone hosts", () => {
    const css = composeSmithersUiStyles({ withTheme: true });
    expect(css).toContain("color-scheme:light");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(":root[data-theme='dark']");
    expect(css.indexOf("color-scheme:light")).toBeLessThan(css.indexOf(".sui-button"));
  });

  test("extra CSS lands after the component sheet", () => {
    const css = composeSmithersUiStyles({ extra: ".mine { color: red; }" });
    expect(css.endsWith(".mine { color: red; }")).toBe(true);
    expect(css).toContain(smithersUiCss);
  });
});
