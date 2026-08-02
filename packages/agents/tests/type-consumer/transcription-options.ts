import { createTranscriptionTool } from "@smthrs/agents";
import type {
  AudioHostResolver,
  CreateTranscriptionToolOptions,
  PinnedAudioTransport,
  PinnedAudioTransportRequest,
  ResolvedAudioAddress,
  TranscriptionProvider,
  TranscriptionToolInput,
  TranscriptionToolResult,
} from "@smthrs/agents";

const resolver: AudioHostResolver = async (_hostname, { signal }) => {
  signal?.throwIfAborted();
  return [{ address: "93.184.216.34", family: 4 }];
};

const transport: PinnedAudioTransport = async (request: PinnedAudioTransportRequest) => {
  request.signal?.throwIfAborted();
  const address: ResolvedAudioAddress = { address: request.address, family: request.family };
  void address;
  return new Response("audio/mpeg");
};

const provider: TranscriptionProvider = "whisper";
const options: CreateTranscriptionToolOptions = {
  provider,
  apiKey: "test-key",
  fetch: globalThis.fetch,
  audioUrlResolver: resolver,
  audioUrlTransport: transport,
  audioUrlMaxRedirects: 3,
};

const input: TranscriptionToolInput = { audioUrl: "https://audio.example.com/input.mp3" };
const result: TranscriptionToolResult = { text: "hello", provider };
const tool = createTranscriptionTool(options);

void input;
void result;
void tool;
