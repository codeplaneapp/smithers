import type { TweetPost } from "@/lib/landing/types";
import { cn } from "@/lib/utils";
import { BarChart2, Heart, MessageCircle, Repeat2 } from "lucide-react";
import Image from "next/image";

function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function VerifiedBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-label="Verified account" className={className}>
      <path
        fill="#1d9bf0"
        d="M22.5 12c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.031-.422-.096l-.422-.216-4.19-2.934c-.524-.369-.643-1.085-.274-1.61.369-.525 1.085-.643 1.61-.274l3.736 2.614 3.838-5.757c.363-.545 1.105-.691 1.65-.328.545.363.69 1.105.327 1.65z"
      />
    </svg>
  );
}

type StatProps = {
  icon: React.ReactNode;
  value: string;
  label: string;
  className?: string;
};

function Stat({ icon, value, label, className }: StatProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[13px] text-[#71767b]",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate tabular-nums">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function XPostCard({
  href,
  authorName,
  authorHandle,
  authorAvatar,
  text,
  postedAt,
  stats,
}: TweetPost) {
  return (
    <article className="landing-enter overflow-hidden rounded-2xl border border-[#2f3336] bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group block px-4 py-3 transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex gap-3">
          <Image
            src={authorAvatar}
            alt=""
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-full bg-[#2f3336] object-cover"
            loading="lazy"
            decoding="async"
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="truncate font-semibold text-[15px] leading-5 text-[#e7e9ea]">
                    {authorName}
                  </span>
                  <VerifiedBadge className="size-[1.125rem] shrink-0" />
                  <span className="truncate text-[15px] leading-5 text-[#71767b]">
                    @{authorHandle}
                  </span>
                  <span className="text-[15px] leading-5 text-[#71767b]" aria-hidden>
                    ·
                  </span>
                  <time
                    dateTime="2026-06-07"
                    className="truncate text-[15px] leading-5 text-[#71767b] group-hover:underline"
                  >
                    {postedAt}
                  </time>
                </div>
              </div>

              <XLogo className="size-[1.125rem] shrink-0 text-[#e7e9ea]" />
            </div>

            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-5 text-[#e7e9ea]">
              {text}
            </p>

            <div className="mt-3 flex max-w-md flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <Stat
                icon={<MessageCircle className="size-[1.125rem]" strokeWidth={1.75} />}
                value={stats.replies}
                label="Replies"
              />
              <Stat
                icon={<Repeat2 className="size-[1.125rem]" strokeWidth={1.75} />}
                value={stats.reposts}
                label="Reposts"
              />
              <Stat
                icon={<Heart className="size-[1.125rem]" strokeWidth={1.75} />}
                value={stats.likes}
                label="Likes"
              />
              <Stat
                icon={<BarChart2 className="size-[1.125rem]" strokeWidth={1.75} />}
                value={stats.views}
                label="Views"
              />
            </div>
          </div>
        </div>
      </a>
    </article>
  );
}
