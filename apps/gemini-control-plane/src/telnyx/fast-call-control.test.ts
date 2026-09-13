import { describe, expect, it } from "vitest";
import { startFastGeminiTelnyxMedia } from "./fast-call-control";

const API_KEY = "test_telnyx_api_key";

describe("fast Telnyx media commands", () => {
  it("answers first and then starts authenticated inbound-only L16 bidirectional media", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await startFastGeminiTelnyxMedia({
      callControlId: "v3:abc_DEF-123",
      edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
      streamAuthToken: "v1.payload.signature",
      answerCommandId: "evt-1:answer",
      streamCommandId: "evt-1:stream",
    }, {
      apiKey: API_KEY,
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ data: { result: "ok" } }, { status: 200 });
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.telnyx.com/v2/calls/v3%3Aabc_DEF-123/actions/answer");
    expect(calls[1].url).toBe("https://api.telnyx.com/v2/calls/v3%3Aabc_DEF-123/actions/streaming_start");
    expect(calls[0].init?.headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ command_id: "evt-1:answer" });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      command_id: "evt-1:stream",
      stream_url: "wss://fast-example.a.run.app/telnyx/gemini",
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_target_legs: "both",
      stream_bidirectional_sampling_rate: 16000,
      stream_auth_token: "v1.payload.signature",
    });
  });

  it("does not attempt streaming if answer fails", async () => {
    let calls = 0;
    await expect(startFastGeminiTelnyxMedia({
      callControlId: "v3:failed",
      edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
      streamAuthToken: "v1.payload.signature",
      answerCommandId: "evt-2:answer",
      streamCommandId: "evt-2:stream",
    }, {
      apiKey: API_KEY,
      fetcher: async () => {
        calls += 1;
        return Response.json({ errors: [{ detail: "failed" }] }, { status: 422 });
      },
    })).rejects.toThrow("Telnyx answer failed");
    expect(calls).toBe(1);
  });

  it("fails closed when Telnyx acknowledgement is malformed", async () => {
    await expect(startFastGeminiTelnyxMedia({
      callControlId: "v3:bad-ack",
      edgeUrl: "wss://fast-example.a.run.app/telnyx/gemini",
      streamAuthToken: "v1.payload.signature",
      answerCommandId: "evt-3:answer",
      streamCommandId: "evt-3:stream",
    }, {
      apiKey: API_KEY,
      fetcher: async () => Response.json({ data: { result: "unexpected" } }, { status: 200 }),
    })).rejects.toThrow("acknowledgement is invalid");
  });
});
