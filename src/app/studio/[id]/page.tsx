import type { Metadata } from "next";
import { ProjectClient } from "@/components/studio/ProjectClient";

export const metadata: Metadata = {
  title: "Project · FirstPlayable",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectClient projectId={id} />;
}
