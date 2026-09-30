import type { Channel } from "../assistant.types";
import type { ChannelAdapter } from "./types";
import { webAdapter } from "./web.channel";

const adapters = new Map<Channel, ChannelAdapter>([["web", webAdapter]]);

export const registerAdapter = (adapter: ChannelAdapter) => adapters.set(adapter.channel, adapter);
export const adapterFor = (channel: Channel) => adapters.get(channel)!;
