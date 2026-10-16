import { notFound } from "next/navigation";
import Home from "../page";
import { isMidasResearchViewId } from "../features/midas/research-contracts";

// Keep workspace deep links on the same shell without swallowing unknown URLs.
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspacePath: string[] }>;
}) {
  const { workspacePath: parts } = await params;
  const [view] = parts;
  const valid = (view === "chart" && parts.length <= 2)
    || ((view === "symbols" || view === "strategies") && parts.length <= 3)
    || (isMidasResearchViewId(view) && parts.length === 1);
  if (!valid) notFound();
  return <Home />;
}
