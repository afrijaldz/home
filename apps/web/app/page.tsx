import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SupportedGlobeDynamic } from "@/client/landing/supported-globe-dynamic";
import { PortfolioHomeExperience } from "@/client/home/home-experience";
import {
  parseShellLocation,
  searchParamsToString,
} from "@/config/shell-location";
import { readRenderSession } from "@/server/auth/render-session";

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  const search = searchParamsToString(query);
  const location = parseShellLocation(query);
  const rendered = readRenderSession(await cookies());
  if (rendered && location.account !== "signin") {
    redirect(search ? `/dashboard?${search}` : "/dashboard");
  }

  // Server geo can later pass a detected country here. The anonymous persisted
  // preference is resolved inside the client boundary; URL shell state is passed
  // from the request so the server and client render the same initial intent.
  return (
    <PortfolioHomeExperience
      detectedCountry={null}
      landingVisual={<SupportedGlobeDynamic />}
      routeMode="landing"
      initialSearch={search}
    />
  );
}
