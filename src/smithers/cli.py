"""Command-line interface for Smithers."""

import argparse
import sys


def main() -> int:
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        prog="smithers",
        description="Build AI agent workflows the way you build software",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Show version and exit",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # run command
    run_parser = subparsers.add_parser("run", help="Run a workflow file")
    run_parser.add_argument("file", help="Path to the workflow file")
    run_parser.add_argument(
        "--cache",
        help="Path to cache database",
        default=None,
    )
    run_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show execution plan without running",
    )

    # graph command
    graph_parser = subparsers.add_parser("graph", help="Visualize workflow graph")
    graph_parser.add_argument("file", help="Path to the workflow file")
    graph_parser.add_argument(
        "--output",
        "-o",
        help="Output file for the graph (default: stdout)",
        default=None,
    )

    args = parser.parse_args()

    if args.version:
        from smithers import __version__

        print(f"smithers {__version__}")
        return 0

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "run":
        return _run_workflow(args)
    elif args.command == "graph":
        return _show_graph(args)

    return 0


def _run_workflow(args: argparse.Namespace) -> int:
    """Run a workflow file."""
    # TODO: Implement
    print(f"Would run workflow from: {args.file}")
    if args.cache:
        print(f"Using cache: {args.cache}")
    if args.dry_run:
        print("(dry run mode)")
    return 0


def _show_graph(args: argparse.Namespace) -> int:
    """Show workflow graph."""
    # TODO: Implement
    print(f"Would show graph for: {args.file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
