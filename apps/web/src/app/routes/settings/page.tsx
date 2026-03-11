import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useSettings } from "@/features/settings/hooks/use-settings"

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings()

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Server configuration</CardTitle>
            <CardDescription>Defaults used by the Burns daemon.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <div className="rounded-xl border bg-muted px-4 py-3">
              workspaceRoot: {isLoading ? "Loading…" : settings?.workspaceRoot}
            </div>
            <div className="rounded-xl border bg-muted px-4 py-3">
              defaultAgent: {isLoading ? "Loading…" : settings?.defaultAgent}
            </div>
            <div className="rounded-xl border bg-muted px-4 py-3">
              smithersBaseUrl: {isLoading ? "Loading…" : settings?.smithersBaseUrl}
            </div>
            <div className="rounded-xl border bg-muted px-4 py-3">
              allowNetwork: {isLoading ? "Loading…" : String(settings?.allowNetwork ?? false)}
            </div>
            <div className="rounded-xl border bg-muted px-4 py-3">
              smithersManagedPerWorkspace:{" "}
              {isLoading ? "Loading…" : String(settings?.smithersManagedPerWorkspace ?? false)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Save changes</CardTitle>
            <CardDescription>Restart required only for schema or registry changes.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button disabled>Apply now</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
