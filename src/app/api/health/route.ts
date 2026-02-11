import { NextResponse } from "next/server";
import { corsHeaders } from "@/lib/utils";
import { sunoApiHealth } from "@/lib/SunoApi";

export const dynamic = "force-dynamic";

export async function GET() {
  return new NextResponse(JSON.stringify(sunoApiHealth()), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders,
  });
}

