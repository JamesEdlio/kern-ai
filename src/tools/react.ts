import { tool } from "ai";
import { z } from "zod";

type ReactFn = (
  channelId: string,
  timestamp: string,
  name: string,
  iface: string,
) => Promise<boolean>;

let _reactFn: ReactFn | null = null;

export function setReactor(fn: ReactFn) {
  _reactFn = fn;
}

export const reactTool = tool({
  description:
    "Add an emoji reaction to a message. Currently Slack only. Use the `ts:` value from the inbound message envelope as `timestamp`, and the channel id (or `#channel-name`) from the envelope as `channelId`. Useful for silently acknowledging a status ping without posting a reply — prefer this over NO_REPLY when you want to show you saw it. Requires the `reactions:write` scope on the Slack app.",
  inputSchema: z.object({
    channelId: z.string().describe("Slack channel ID (e.g. C0123ABC) or channel name — must match where the message lives."),
    timestamp: z.string().describe("Slack message `ts` identifier. Read this from the inbound envelope's `ts:` field."),
    name: z.string().describe("Emoji name without colons, e.g. `white_check_mark`, `eyes`, `thumbsup`."),
    interface: z.string().default("slack").describe("The interface to react on. Only `slack` is currently supported."),
  }),
  execute: async ({ channelId, timestamp, name, interface: iface }) => {
    if (!_reactFn) return "Error: reactions not available — no react function configured.";
    if (iface !== "slack") return `Error: reactions not supported on ${iface} (only slack).`;
    try {
      const ok = await _reactFn(channelId, timestamp, name, iface);
      if (ok) return `Reacted with :${name.replace(/^:|:$/g, "")}: on ${channelId}/${timestamp}.`;
      return `Failed to react — check scope (reactions:write), channel membership, or message id.`;
    } catch (e: any) {
      return `Error reacting: ${e.message}`;
    }
  },
});
