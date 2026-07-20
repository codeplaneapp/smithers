import type { EditedContent, ReleaseContentInput } from "./schemas";

type TweetPostResult = {
  tweetId: string;
  posted: boolean;
  error?: string;
};

function missingCredentialMessage(): string | null {
  const required = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  return missing.length > 0 ? `Missing ${missing.join(", ")} env var(s).` : null;
}

async function postTweet(text: string, replyToId?: string): Promise<TweetPostResult> {
  const missing = missingCredentialMessage();
  if (missing) return { tweetId: "", posted: false, error: missing };
  const { TwitterApi } = (await import("twitter-api-v2")) as typeof import("twitter-api-v2");
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY ?? "",
    appSecret: process.env.X_API_SECRET ?? "",
    accessToken: process.env.X_ACCESS_TOKEN ?? "",
    accessSecret: process.env.X_ACCESS_SECRET ?? "",
  });
  const params = replyToId ? { text, reply: { in_reply_to_tweet_id: replyToId } } : { text };
  const { data } = await client.v2.tweet(params);
  return { tweetId: data.id, posted: true };
}

export async function postThread(params: {
  input: ReleaseContentInput;
  content: EditedContent;
}) {
  const { input, content } = params;
  const tweets = content.tweetThread?.tweets ?? [];
  if (input.dryRun) {
    return {
      published: false,
      dryRun: true,
      files: [],
      tweetIds: [],
      message: `Dry run enabled; would post ${tweets.length} tweet(s).`,
    };
  }
  if (!input.publish) {
    return {
      published: false,
      dryRun: false,
      files: [],
      tweetIds: [],
      message: "publish=false; X thread was not posted.",
    };
  }
  const missing = missingCredentialMessage();
  if (missing) {
    throw new Error(missing);
  }

  const tweetIds: string[] = [];
  let replyToId: string | undefined;
  for (const tweet of tweets) {
    const result = await postTweet(tweet.text, replyToId);
    if (!result.posted || !result.tweetId) {
      throw new Error(result.error ?? `Tweet ${tweet.index} did not return an id.`);
    }
    tweetIds.push(result.tweetId);
    replyToId = result.tweetId;
    if (input.tweetThread.delaySeconds > 0 && tweet.index < tweets.length) {
      await new Promise((resolve) => setTimeout(resolve, input.tweetThread.delaySeconds * 1000));
    }
  }

  return {
    published: tweetIds.length > 0,
    dryRun: false,
    files: [],
    tweetIds,
    message: tweetIds.length > 0 ? `Posted ${tweetIds.length} tweet(s).` : "No tweets to post.",
  };
}
