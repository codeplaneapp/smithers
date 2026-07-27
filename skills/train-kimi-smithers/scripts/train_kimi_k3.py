#!/usr/bin/env python3
"""Run the official Fireworks cookbook SFT loop against the Kimi K3 serverless pool."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output-model-id", required=True)
    parser.add_argument("--log-path", default="artifacts/kimi-smithers/k3-training")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--max-seq-len", type=int, default=32768)
    parser.add_argument("--max-examples", type=int)
    parser.add_argument("--print-config", action="store_true")
    parser.add_argument("--confirm-spend", action="store_true")
    return parser.parse_args()


def resolved_plan(args: argparse.Namespace) -> dict[str, object]:
    return {
        "path": "Fireworks Training API serverless private preview",
        "method": "LoRA SFT",
        "base_model": "accounts/fireworks/models/kimi-k3",
        "tokenizer_model": "moonshotai/Kimi-K3",
        "renderer_name": "kimi_k3",
        "thinking_trace_history_mode": "preserved",
        "dataset": str(args.dataset.resolve()),
        "output_model_id": args.output_model_id,
        "epochs": args.epochs,
        "batch_size_samples": args.batch_size,
        "learning_rate": args.learning_rate,
        "lora_rank": args.lora_rank,
        "max_seq_len": args.max_seq_len,
        "max_examples": args.max_examples,
        "billing": "private-preview pay per token; confirm live account rate",
    }


def validate(args: argparse.Namespace) -> None:
    if not args.dataset.is_file():
        raise SystemExit(f"Dataset does not exist: {args.dataset}")
    if args.dataset.suffix != ".jsonl":
        raise SystemExit("--dataset must be an uncompressed .jsonl file")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.output_model_id):
        raise SystemExit("--output-model-id must be lowercase kebab-case")
    if args.epochs < 1:
        raise SystemExit("--epochs must be at least 1")
    if args.batch_size < 1:
        raise SystemExit("--batch-size must be at least 1")
    if args.lora_rank < 1:
        raise SystemExit("Serverless Training is LoRA-only; --lora-rank must be positive")
    if args.max_seq_len < 1024:
        raise SystemExit("--max-seq-len must be at least 1024")


def main() -> None:
    args = parse_args()
    validate(args)
    plan = resolved_plan(args)
    print(json.dumps(plan, indent=2))
    if args.print_config:
        return
    if not args.confirm_spend:
        raise SystemExit("Plan only. Re-run with --confirm-spend after confirming preview access and live pricing.")
    if not os.environ.get("FIREWORKS_API_KEY"):
        raise SystemExit("FIREWORKS_API_KEY is required")

    try:
        from training.recipes import sft_loop
    except ImportError as error:
        raise SystemExit(
            "Install the pinned official cookbook first: "
            "git clone https://github.com/fw-ai/cookbook.git && "
            "pip install -e cookbook/training"
        ) from error

    config = sft_loop.Config(
        log_path=args.log_path,
        base_model=plan["base_model"],
        dataset=str(args.dataset),
        tokenizer_model=plan["tokenizer_model"],
        tokenizer_trust_remote_code=True,
        renderer_name=plan["renderer_name"],
        thinking_trace_history_mode=plan["thinking_trace_history_mode"],
        train_on_what="all_assistant_messages",
        learning_rate=args.learning_rate,
        epochs=args.epochs,
        batch_size=args.batch_size,
        max_seq_len=args.max_seq_len,
        max_examples=args.max_examples,
        lora_rank=args.lora_rank,
        output_model_id=args.output_model_id,
        serverless=True,
    )
    metrics = sft_loop.main(config)
    print(json.dumps({"status": "completed", "metrics": metrics}, default=str, indent=2))


if __name__ == "__main__":
    main()
