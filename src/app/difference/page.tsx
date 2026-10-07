import { RehearsalScene } from "@/components/rehearsal/RehearsalScene";

export const metadata = {
  title: "The Second Copy · FirstPlayable",
  description:
    "Saved example, a synthetic deterministic demonstration. Play it with and without the approved influence; nothing is generated live.",
};

type Params = Promise<Record<string, string | string[] | undefined>>;

/**
 * `?view=play` and `?view=compare` open that mode directly. With no view, the
 * saved example opens on Play at the recorded point and splits into Compare
 * by itself, as the judge path does.
 */
export default async function DifferencePage({ searchParams }: { searchParams: Params }) {
  const view = (await searchParams)["view"];
  const initialView = view === "compare" ? "compare" : "play";
  return <RehearsalScene initialView={initialView} autoSplit={view === undefined} />;
}
