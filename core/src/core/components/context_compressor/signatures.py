"""Vinv Engine / components / context_compressor / signatures — DSPy signature for context compression."""

import dspy

from core.components.agents import prompts


class ContextCompressionSignature(dspy.Signature):
    """Compress context while preserving facts needed for task execution."""

    context_text: str = dspy.InputField(desc="Context text to compress")
    max_length: str = dspy.InputField(
        desc="Target maximum character length for compressed output. "
             "If empty, compress to roughly half the input length.",
        default=""
    )
    compressed_context: str = dspy.OutputField(
        desc="Compressed context preserving ALL facts, paths, errors, commands, "
             "and structured data. Never invent content not in context_text."
    )


class OutputDistillationSignature(dspy.Signature):
    """Distill a task's raw output for consumption by downstream tasks."""

    task_name: str = dspy.InputField(desc="What this task accomplished")
    goal: str = dspy.InputField(desc="The overall pipeline goal")
    raw_output: str = dspy.InputField(desc="Full raw output from the executor")
    downstream_tasks: str = dspy.InputField(
        desc="Names of tasks that will consume this output (may be empty)"
    )
    distilled_output: str = dspy.OutputField(
        desc="Distilled output derived ONLY from raw_output. Contains all facts, "
             "paths, errors, and structured data. Never invent new content."
    )


prompts.apply(ContextCompressionSignature, "context_compression")
prompts.apply(OutputDistillationSignature, "output_distillation")
