"""
Base Swarm Agent implementation.

This provides the common functionality for all 6 swarm agents,
including both terminal and web search tools.
"""

from typing import Any, AsyncGenerator, Optional, get_type_hints
import asyncio
import inspect
import json
import logging
import os
import time
from datetime import datetime

# Use standard logging
import logging

try:
    import dspy
except ImportError:
    dspy = None

if dspy is not None:
    try:
        dspy.configure_cache(
            enable_disk_cache=False,
            enable_memory_cache=False,
        )
    except (RuntimeError, Exception, AttributeError):
        pass

BaseCallback = None
if dspy is not None:
    try:
        from dspy.utils.callback import BaseCallback
    except ImportError:
        pass

AdapterParseError = Exception
if dspy is not None:
    try:
        from dspy.utils.exceptions import AdapterParseError
    except ImportError:
        pass

try:
    from litellm.exceptions import Timeout as LiteLLMTimeout
    from litellm.exceptions import RateLimitError as LiteLLMRateLimitError
    from litellm import ContextWindowExceededError as LiteLLMContextWindowError
    import litellm
except ImportError:
    LiteLLMTimeout = None
    LiteLLMRateLimitError = None
    LiteLLMContextWindowError = None
    litellm = None

# ═══════════════════════════════════════════════════════════
# FIX: Patch DSPy Tool._validate_and_parse_args to filter
# unknown arguments instead of raising ValueError.
#
# The LLM frequently generates tool calls with extra fields
# from the ReAct output schema (e.g. 'analysis',
# 'collaboration_actions', 'status') which are NOT valid
# tool arguments. DSPy's default behaviour raises ValueError
# causing the tool call to fail and waste a ReAct step.
# This patch silently strips unknown args and logs a warning.
# ═══════════════════════════════════════════════════════════
_DSPY_TOOL_PATCH_APPLIED = False
_tool_patch_logger = logging.getLogger("vinv_engine.agents.dspy_tool_patch")


def _apply_dspy_tool_patch():
    """Apply (or re-apply) the DSPy Tool arg-filter patch.

    Safe to call multiple times — skips if already patched. Called both
    at module-import time and as a safety net in BaseSwarmAgent.__init__.
    """
    global _DSPY_TOOL_PATCH_APPLIED
    if _DSPY_TOOL_PATCH_APPLIED:
        return

    if dspy is None:
        return

    try:
        from dspy.adapters.types.tool import Tool as _DspyTool

        # Guard: don't re-patch if someone already wrapped the method
        if getattr(_DspyTool._validate_and_parse_args, "_arg_filter_patched", False):
            _DSPY_TOOL_PATCH_APPLIED = True
            return

        _original = _DspyTool._validate_and_parse_args

        def _patched_validate_and_parse_args(self, **kwargs):
            """Filter out unknown tool args instead of raising ValueError."""
            if self.args is not None and not self.has_kwargs:
                unknown_keys = [k for k in kwargs if k not in self.args]
                if unknown_keys:
                    _tool_patch_logger.warning(
                        "🔧 [TOOL ARG FILTER] Stripped unknown args from "
                        "tool '%s': %s", self.name, unknown_keys,
                    )
                    kwargs = {k: v for k, v in kwargs.items() if k in self.args}
            return _original(self, **kwargs)

        _patched_validate_and_parse_args._arg_filter_patched = True
        _DspyTool._validate_and_parse_args = _patched_validate_and_parse_args
        _DSPY_TOOL_PATCH_APPLIED = True
        _tool_patch_logger.warning(
            "✅ DSPy Tool._validate_and_parse_args patched — unknown args will be filtered"
        )
    except Exception as _patch_err:
        _tool_patch_logger.warning(
            "⚠️ Could not patch DSPy Tool._validate_and_parse_args: %s", _patch_err,
        )


# Apply at module import time
_apply_dspy_tool_patch()

from core.components.tools.terminal.terminal_tools import (
    initialize_terminal,
    close_terminal,
    send_terminal_command,
    get_terminal_state,
    get_incremental_output,
    set_terminal_session
)
# web/collaboration tool categories are not vendored into `core`. They are
# only referenced by the default ``TOOLS`` list, which executor subclasses
# (e.g. TerminalExecutorAgent) override, so stubbing them is safe.
try:
    from core.components.tools.web.web_search import web_search, scrape_website
except ImportError:  # pragma: no cover - cut from the core closure
    def web_search(*args, **kwargs):  # type: ignore[misc]
        raise NotImplementedError("web_search is not available in core")

    def scrape_website(*args, **kwargs):  # type: ignore[misc]
        raise NotImplementedError("scrape_website is not available in core")

try:
    from core.components.tools.collaboration.collab_tool import collaborate
except ImportError:  # pragma: no cover - cut from the core closure
    def collaborate(*args, **kwargs):  # type: ignore[misc]
        raise NotImplementedError("collaborate is not available in core")
from core.components.agents.core.core import log_agent_model_usage
from core.components.agents.utils.retry import is_timeout_error
from core.components.timeout_registry import get_timeout_seconds
from . import prompts

COMPRESSOR_AVAILABLE = False
AgenticCompressor = None


class AgentCollaborationMixin:
    """Stub collaboration mixin."""
    def set_collaboration_context(self, *args, **kwargs):
        pass

COLLABORATION_AVAILABLE = False

if dspy is not None:
    # ═══════════════════════════════════════════════════════════════
    # VISUAL VERIFICATION PROTOCOL (VVP)
    # ═══════════════════════════════════════════════════════════════
    # 
    # A-TEAM DEBATE RESOLUTION (2026-02-08):
    #   This prompt block is injected into ALL agents. It teaches the
    #   REASONING PATTERN for visual verification — no hardcoded examples,
    #   no specific scenarios, only principles and decision criteria.
    #
    #   Philosophy: Visual inspection = OBSERVATION action that reduces
    #   state uncertainty. Use it when: H(state) > threshold, where
    #   H(state) is the entropy of your belief about the current state.
    #
    #   The agent's LLM + tool docstrings handle TOOL SELECTION naturally.
    # ═══════════════════════════════════════════════════════════════
    VISUAL_VERIFICATION_PROTOCOL = prompts.get("visual_verification_protocol")

    # ═══════════════════════════════════════════════════════════════
    # DEBUGGING PROTOCOL
    # ═══════════════════════════════════════════════════════════════
    #
    # Language-agnostic debugging reasoning protocol.  Teaches HOW to
    # think about debugging, not language-specific rules.  The LLM
    # chooses the right tool and constructs the right command.
    # ═══════════════════════════════════════════════════════════════
    DEBUGGING_PROTOCOL = prompts.get("debugging_protocol")

    class AdaptiveCompletionReviewSignature(dspy.Signature):
        """
        LLM self-review of completion quality to preserve partial progress and unresolved gaps.
        """
        instruction = dspy.InputField(desc="Original task instruction")
        analysis = dspy.InputField(desc="Agent analysis output")
        reasoning = dspy.InputField(desc="Agent reasoning output")
        plan = dspy.InputField(desc="Agent plan output")
        trajectory_summary = dspy.InputField(desc="Compact summary of attempted actions/observations")
        prior_attempt_context = dspy.InputField(desc="Context from previous attempts/failures")
        task_complete_signal = dspy.InputField(desc="Whether actor marked task_complete true/false")

        completion_state = dspy.OutputField(
            desc="A concise label for completion state (e.g., 'complete', 'partial', 'blocked' or similar)"
        )
        confidence = dspy.OutputField(
            desc="Confidence in completion_state between 0 and 1"
        )
        rationale = dspy.OutputField(
            desc="Why this state is correct based on evidence and attempts"
        )
        unresolved_items_json = dspy.OutputField(
            desc="JSON list of unresolved gaps if any; [] if none"
        )
        next_step_guidance = dspy.OutputField(
            desc="Generic guidance for next actor/iteration based on unresolved gaps"
        )
        missing_capability_detected = dspy.OutputField(
            desc="true if the agent identified a tool/skill/capability that is needed but not available; false otherwise"
        )
        proposed_skill_spec = dspy.OutputField(
            desc="JSON spec of the missing skill if missing_capability_detected is true: {name, description, inputs, outputs, rationale}. Empty string if no missing capability."
        )

    class BaseSwarmAgent(dspy.Module, AgentCollaborationMixin):
        """Base class for all swarm agents with terminal and web search capabilities.
        
        Now includes agent-to-agent collaboration via AgentCollaborationMixin.
        Includes Visual Verification Protocol (VVP) for VLM-powered state extraction.
        """

        # Override in subclasses
        AGENT_NAME = "BaseSwarmAgent"
        SIGNATURE_CLASS = None
        SYSTEM_PROMPT = "You are a helpful agent."
        # Override in subclasses to specify agent-specific tools
        TOOLS = [
            initialize_terminal,
            close_terminal,
            send_terminal_command, 
            get_terminal_state, 
            get_incremental_output,
            web_search,
            scrape_website,
            collaborate,
        ]

        def __init__(self, max_iters: Optional[int] = None, tools: list = None) -> None:
            super().__init__()
            
            # Verify the DSPy tool arg patch is active. If the module-level
            # patch didn't run (e.g. import order), re-apply it now.
            if not _DSPY_TOOL_PATCH_APPLIED:
                _apply_dspy_tool_patch()
            
            if self.SIGNATURE_CLASS is None:
                raise ValueError("SIGNATURE_CLASS must be set in subclass")

            max_iters = max_iters if max_iters is not None else int(os.environ.get("VINV_ENGINE_AGENT_MAX_ITERS", "50"))

            # Use provided tools or class-level TOOLS
            self._tools_list = tools if tools is not None else self.TOOLS
            
            from core.components.agents.vinv_engine_react import VinvEngineReAct
            self.generate = VinvEngineReAct(
                self.SIGNATURE_CLASS,
                tools=self._tools_list,
                max_iters=max_iters,
            )
            self.logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
            self.model_id = None
            self.terminal_session = None
            self._cancellation_flag = None  # Set by AgentActor for cooperative shutdown
            # Append Visual Verification + Debugging Protocols to every agent's
            # system prompt so ALL agents know how to reason about verification
            # and debugging generically.
            self.system_prompt = self.SYSTEM_PROMPT + VISUAL_VERIFICATION_PROTOCOL + DEBUGGING_PROTOCOL
            
            # Initialize compressor for automatic context length handling
            self._compressor = AgenticCompressor() if COMPRESSOR_AVAILABLE else None
            self._max_compression_retries = int(
                os.environ.get("VINV_ENGINE_COMPRESSION_MAX_RETRIES", "3")
            )
            
            # Initialize collaboration attributes (will be set by Conductor)
            if COLLABORATION_AVAILABLE:
                self._agent_slack = None
                self._agent_directory = None
                self._my_name = None
                self._pending_messages = []
                self._collaboration_history = []

        _CallbackBase = BaseCallback if BaseCallback is not None else object

        class _ReActStreamCallback(_CallbackBase):
            """Callback to stream ReAct intermediate steps into an asyncio.Queue."""

            def __init__(self, queue: "asyncio.Queue[dict]", agent_name: str) -> None:
                self.queue = queue
                self.agent_name = agent_name
                self.step_count = 0
                self.start_time = time.time()
                self.logger = logging.getLogger(f"{__name__}.{agent_name}")
                self.last_step_time = self.start_time
                self._finished = False
                self._module_depth = 0  # Track nesting — only log outermost

            def _enqueue(self, message: str, event_type: str = "thinking") -> None:
                try:
                    formatted_message = {"event": event_type, "data": {"agent": self.agent_name, "data": message}}
                    self.queue.put_nowait(formatted_message)
                except Exception:
                    pass

            def _truncate(self, text: str, limit: int = 0) -> str:
                """Return full text without truncation.

                The limit parameter is kept for signature compatibility
                but ignored — context sizing is handled downstream by
                the compression pipeline, not by hard string slicing.
                """
                try:
                    return str(text)
                except Exception:
                    return str(text)

            def _format_outputs(self, outputs) -> None:
                if self._finished:
                    return

                try:
                    data = outputs if isinstance(outputs, dict) else getattr(outputs, "__dict__", {})
                except Exception:
                    data = {}
                    self.logger.warning(f"  ⚠️  Failed to extract output data")

                store = data.get("_store") if isinstance(data, dict) else None

                # Detect real ReAct content BEFORE bumping the step counter or
                # emitting a banner. DSPy fires on_module_end for inner
                # sub-modules too (e.g. each context-compression chunk call),
                # which arrive with an empty/contentless store. Logging those as
                # "REACT STEP N" floods the log with hundreds of contentless
                # "No reasoning in step" entries and inflates the counter so it
                # no longer maps to actual agent turns. Skip them entirely.
                thought = action = args = observation = None
                relevant_items: list = []
                if isinstance(store, dict):
                    thought = store.get("next_thought") or store.get("thought")
                    action = store.get("next_tool_name") or store.get("action")
                    args = store.get("next_tool_args") or store.get("tool_input")
                    observation = store.get("observation")
                else:
                    try:
                        relevant_items = [
                            (str(k).lower(), k, v)
                            for k, v in (data.items() if isinstance(data, dict) else [])
                            if any(t in str(k).lower() for t in ("thought", "action", "observation"))
                        ]
                    except Exception:
                        relevant_items = []

                if not (thought or action or args or observation or relevant_items):
                    return

                self.step_count += 1
                step_start_time = time.time()
                step_duration = step_start_time - self.last_step_time
                elapsed_total = step_start_time - self.start_time

                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                self.logger.info(f"{'='*80}")
                self.logger.info(f"🔄 REACT STEP {self.step_count} | agent={self.agent_name} | "
                               f"timestamp={timestamp} | step_duration={step_duration:.3f}s | "
                               f"elapsed_total={elapsed_total:.3f}s")
                self.logger.info(f"[💭 THINKING LOG] ReAct step START | step={self.step_count} | "
                               f"agent={self.agent_name} | step_duration={step_duration:.3f}s | "
                               f"elapsed_total={elapsed_total:.3f}s")

                if isinstance(store, dict):
                    if thought:
                        thought_str = str(thought)
                        thought_log_start = time.time()
                        self.logger.info(f"  💭 REASONING: {thought_str}")
                        self.logger.info(f"[💭 THINKING LOG] Reasoning captured | step={self.step_count} | "
                                       f"agent={self.agent_name} | reasoning_length={len(thought_str)} chars | "
                                       f"timestamp={thought_log_start}")
                        self.logger.debug(f"    Reasoning length: {len(thought_str)} chars")
                        self._enqueue("I'm thinking: " + self._truncate(thought, 1600))
                    else:
                        self.logger.debug(f"  ⚠️  No reasoning/thought found in this step")
                        self.logger.info(f"[💭 THINKING LOG] No reasoning in step | step={self.step_count} | "
                                       f"agent={self.agent_name}")
                    
                    if action and str(action).strip().lower() != "finish":
                        action_str = str(action)
                        self.logger.info(f"  🛠️  ACTION: {action_str}")
                        self._enqueue("🛠️ Action: " + action_str)
                    elif action and str(action).strip().lower() == "finish":
                        self.logger.info(f"  ✅ ACTION: finish (completing task)")
                        self._enqueue("✅ Finishing task")
                        self._finished = True
                    
                    # Log tool arguments
                    if isinstance(args, dict):
                        try:
                            preview = json.dumps(args)
                            self.logger.info(f"  📦 TOOL_ARGS: {preview}")
                            self.logger.debug(f"    Args keys: {list(args.keys())}")
                        except Exception:
                            preview = str(args)
                            self.logger.info(f"  📦 TOOL_ARGS: {preview}")
                        self._enqueue("📦 Input: " + preview)
                    elif args is not None:
                        args_str = str(args)
                        self.logger.info(f"  📦 TOOL_ARGS: {args_str}{'...' if len(args_str) > 500 else ''}")
                        self._enqueue("📦 Input: " + self._truncate(args, 800))
                    else:
                        self.logger.debug(f"  ⚠️  No tool arguments")
                    
                    # Log observation
                    if observation:
                        obs_str = str(observation)
                        obs_len = len(obs_str)
                        self.logger.info(f"  🔎 OBSERVATION: {obs_str}{'...' if obs_len > 200 else ''}")
                        self.logger.debug(f"    Observation length: {obs_len} chars")
                        self._enqueue("🔎 Observation: " + self._truncate(observation, 1600))
                    else:
                        self.logger.debug(f"  ⚠️  No observation yet")
                    
                    step_end_time = time.time()
                    final_step_duration = step_end_time - self.last_step_time
                    self.logger.info(f"  ✅ STEP {self.step_count} COMPLETE | duration={step_duration:.3f}s")
                    self.logger.info(f"[💭 THINKING LOG] ReAct step END | step={self.step_count} | "
                                   f"agent={self.agent_name} | step_duration={final_step_duration:.3f}s | "
                                   f"elapsed_total={step_end_time - self.start_time:.3f}s")
                    self.last_step_time = step_start_time
                    return

                # Fallback: render the relevant items detected above (store was
                # not a dict). relevant_items is non-empty here — contentless
                # callbacks already returned before the counter was bumped.
                self.logger.debug(f"  Processing {len(relevant_items)} data items")
                for lower_key, original_key, value in relevant_items:
                    value_str = str(value)
                    if "thought" in lower_key:
                        self.logger.info(f"  💭 REASONING ({original_key}): {value_str}{'...' if len(value_str) > 200 else ''}")
                        self._enqueue("I'm thinking: " + self._truncate(value, 1600))
                    if "action" in lower_key and str(value).strip().lower() != "finish":
                        self.logger.info(f"  🛠️  ACTION ({original_key}): {value_str}")
                        self._enqueue("Action: " + self._truncate(value, 400))
                    if "observation" in lower_key:
                        self.logger.info(f"  🔎 OBSERVATION ({original_key}): {value_str}{'...' if len(value_str) > 200 else ''}")
                        self._enqueue("Observation: " + self._truncate(value, 1600))

                self.logger.info(f"  ✅ STEP {self.step_count} COMPLETE | duration={step_duration:.3f}s")
                self.last_step_time = step_start_time

            def on_module_start(self, *args, **kwargs):
                self._module_depth += 1
                if self._module_depth > 1:
                    return  # Sub-module (inner predict, synthesis) — skip logging
                self.start_time = time.time()
                self.last_step_time = self.start_time
                self.step_count = 0
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                self.logger.info(f"🚀 REACT MODULE START | agent={self.agent_name} | timestamp={timestamp}")
                self._enqueue(f"🚀 {self.agent_name} starting execution...")

            def on_module_end(self, *args, **kwargs):
                self._module_depth = max(0, self._module_depth - 1)

                outputs = kwargs.get("outputs") if len(args) < 3 else args[2]
                exception = kwargs.get("exception") if len(args) < 4 else (args[3] if len(args) >= 4 else None)

                # Depth 1 = per-step predict sub-module ending.
                # Process step outputs (tool args, reasoning) so the code
                # panel and thinking log get per-step events.
                if self._module_depth >= 1:
                    if outputs is not None and not self._finished:
                        self._format_outputs(outputs)
                    return

                # Depth 0 = outermost ReAct module ending — log summary.
                end_time = time.time()
                total_duration = end_time - self.start_time
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

                if exception is not None:
                    self.logger.info(f"🏁 REACT MODULE END | agent={self.agent_name} | "
                                   f"timestamp={timestamp} | total_steps={self.step_count} | "
                                   f"total_duration={total_duration:.3f}s")
                    self.logger.error(f"  ❌ EXCEPTION: {type(exception).__name__}: {exception}")
                    self._enqueue(f"Oops, I encountered an error: {exception}")
                    return

                if outputs is not None and not self._finished:
                    self.logger.info(f"  📤 Processing final outputs")
                    self._format_outputs(outputs)
                    self.logger.info(f"  ✅ Final outputs processed")

                self.logger.info(f"🏁 REACT MODULE END | agent={self.agent_name} | "
                               f"timestamp={timestamp} | total_steps={self.step_count} | "
                               f"total_duration={total_duration:.3f}s")

            def on_tool_start(self, *args, **kwargs):
                tool_name = kwargs.get("tool_name") if kwargs else (args[0] if args else "unknown")
                if not tool_name or str(tool_name).lower() in ("none", "finish"):
                    return
                tool_start_time = time.time()
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                self.logger.info(f"  🔧 TOOL START: {tool_name} | timestamp={timestamp}")
                self.logger.debug(f"    Tool args: {args[1:] if len(args) > 1 else 'None'}")
                self.logger.debug(f"    Tool kwargs: {kwargs}")
                self._enqueue(f"🔧 Using tool: {tool_name}")

            def on_tool_end(self, *args, **kwargs):
                tool_name = kwargs.get("tool_name") if kwargs else (args[0] if args else "unknown")
                if not tool_name or str(tool_name).lower() in ("none", "finish"):
                    return
                tool_end_time = time.time()
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                
                result = kwargs.get("result") if kwargs else (args[1] if len(args) > 1 else None)
                if result:
                    result_str = str(result)
                    result_len = len(result_str)
                    self.logger.info(f"  ✅ TOOL END: {tool_name} | timestamp={timestamp} | "
                                   f"result_length={result_len} chars")
                    self.logger.debug(f"    Result preview: {result_str}{'...' if result_len > 300 else ''}")
                    self._enqueue(f"✅ {tool_name} completed ({result_len} chars)")
                else:
                    self.logger.info(f"  ✅ TOOL END: {tool_name} | timestamp={timestamp} | no result")
                    self._enqueue(f"✅ {tool_name} completed")
                
                exception = kwargs.get("exception") if kwargs else (args[2] if len(args) > 2 else None)
                if exception:
                    self.logger.error(f"    ❌ Tool exception: {type(exception).__name__}: {exception}")
                    self._enqueue(f"❌ {tool_name} error: {str(exception)}")

        def restore_tools(self):
            """Restore tools after optimization/loading."""
            # Build tools dict from the agent's tool list
            tools_dict = {}
            for tool in self._tools_list:
                tool_name = tool.__name__ if hasattr(tool, '__name__') else str(tool)
                tools_dict[tool_name] = tool
            
            # 🔧 FIX: Preserve DSPy ReAct's built-in 'finish' tool with argument filtering
            if hasattr(self.generate, 'tools') and 'finish' in self.generate.tools:
                original_finish = self.generate.tools['finish']
                # Wrap finish tool to filter out invalid arguments (finish only accepts final_answer)
                def wrapped_finish(*args, **kwargs):
                    # Filter kwargs to only include final_answer (the only valid argument for finish)
                    filtered_kwargs = {k: v for k, v in kwargs.items() if k == 'final_answer'}
                    # If final_answer not in kwargs, try to extract from args or use first arg
                    if 'final_answer' not in filtered_kwargs and args:
                        filtered_kwargs['final_answer'] = args[0] if args else ''
                    # Call original finish with only valid arguments
                    return original_finish(**filtered_kwargs)
                wrapped_finish.__name__ = 'finish'
                wrapped_finish.__doc__ = getattr(original_finish, '__doc__', 'Finish the task with final answer')
                tools_dict['finish'] = wrapped_finish
            
            if hasattr(self.generate, 'tools') and not self.generate.tools:
                self.generate.tools = tools_dict
            elif not hasattr(self.generate, 'tools'):
                self.generate.tools = tools_dict

        def set_session(self, session):
            """
            Set the terminal session for this agent.
            
            Parameters
            ----------
            session : str or pexpect.spawn
                Terminal session identifier (string) or actual pexpect session object.
                If a string is passed, it's stored as metadata but not used to override
                the global terminal session (which is managed by terminal_tools).
            """
            self.terminal_session = session
            
            # Only call set_terminal_session if it's an actual session object, not a string
            if not isinstance(session, str):
                set_terminal_session(session)
            # If it's a string, just store it as metadata - the actual pexpect session
            # is managed by terminal_tools via initialize_terminal()

        def _uses_terminal_tools(self) -> bool:
            """Introspect whether any tool in this agent's TOOLS originates from
            the terminal_tools module.  Uses module-path introspection rather
            than name matching so it stays correct as tools are renamed or added."""
            term_module = "vinv_engine.components.tools.terminal.terminal_tools"
            for tool in getattr(self, "TOOLS", []):
                fn = tool if callable(tool) else getattr(tool, "func", None)
                if fn is None:
                    continue
                mod = getattr(fn, "__module__", "") or ""
                if mod == term_module or mod.endswith(".terminal_tools"):
                    return True
            return False

        async def _review_completion_state(
            self,
            instruction: str,
            result: Any,
            execution_context: Optional[dict] = None,
        ) -> None:
            """
            LLM-based post-hoc completion review.
            Adds completion_state + unresolved gaps to result._store for downstream auditors/RL.
            """
            try:
                reviewer = dspy.ChainOfThought(AdaptiveCompletionReviewSignature)
                store = getattr(result, "_store", {}) if result is not None else {}
                trajectory = store.get("trajectory", {}) if isinstance(store, dict) else {}
                trajectory_summary = {
                    "steps": len([k for k in trajectory.keys() if str(k).startswith("tool_name_")]),
                    "tools": [trajectory.get(k) for k in trajectory.keys() if str(k).startswith("tool_name_")],
                    "last_observation": str(
                        trajectory.get(f"observation_{max(0, len([k for k in trajectory.keys() if str(k).startswith('tool_name_')]) - 1)}", "")
                    ) if isinstance(trajectory, dict) else "",
                }

                prior_attempt_context = ""
                if isinstance(execution_context, dict):
                    prior_attempt_context = str(
                        execution_context.get("LAST_FAILURE_CONTEXT")
                        or execution_context.get("last_failure_context")
                        or execution_context.get("retry_context")
                        or ""
                    )

                review = await reviewer.aforward(
                    instruction=str(instruction),
                    analysis=str(getattr(result, "analysis", "")),
                    reasoning=str(getattr(result, "reasoning", "")),
                    plan=str(getattr(result, "plan", "")),
                    trajectory_summary=json.dumps(trajectory_summary, default=str),
                    prior_attempt_context=prior_attempt_context,
                    task_complete_signal=str(getattr(result, "task_complete", False)),
                )

                completion_state = str(getattr(review, "completion_state", "partial")).strip().lower()
                if completion_state not in ["complete", "partial", "blocked"]:
                    completion_state = "partial"

                unresolved_items = []
                unresolved_raw = getattr(review, "unresolved_items_json", "[]")
                try:
                    parsed = json.loads(unresolved_raw) if isinstance(unresolved_raw, str) else unresolved_raw
                    if isinstance(parsed, list):
                        unresolved_items = parsed
                except Exception:
                    unresolved_items = []

                if not hasattr(result, "_store") or not isinstance(result._store, dict):
                    result._store = {}
                result._store["completion_state"] = completion_state
                result._store["completion_confidence"] = str(getattr(review, "confidence", "0.5"))
                result._store["completion_rationale"] = str(getattr(review, "rationale", ""))
                result._store["unresolved_items"] = unresolved_items
                result._store["next_step_guidance"] = str(getattr(review, "next_step_guidance", ""))

                # Keep existing task_complete if complete; preserve partial progress visibility otherwise.
                if completion_state == "complete":
                    result._store["task_complete"] = True
                elif completion_state in ["partial", "blocked"] and "task_complete" not in result._store:
                    result._store["task_complete"] = False

            except Exception as e:
                self.logger.debug(f"Completion review unavailable: {e}")

        async def _truncate_tool_result(self, result_str: str, tool_name: str) -> str:
            """Compress large tool results via LLM to prevent context explosion.

            When tool results (e.g. accessibility tree snapshots of 30-36K chars)
            accumulate across ReAct steps, the trajectory grows unboundedly and
            causes inference latency to become nonlinear.  This method compresses
            results that exceed a configurable char threshold using the
            ContentIngestionPipeline — the same LLM-based compression used
            elsewhere in Vinv Engine.  The compression is contextual and advisory,
            preserving all critical details (element refs, text content, structure)
            while removing redundant accessibility metadata.
            """
            # Per-agent tool result compress threshold.
            # Browser/Desktop produce massive accessibility trees (50K+ per snapshot)
            # that accumulate across steps. Compress earlier to prevent overflow.
            _BROWSER_THRESHOLD = 120_000   # 30k tokens — compress browser results early
            _DEFAULT_THRESHOLD = 360_000   # 90k tokens — default for other agents
            _agent_name = getattr(self, "AGENT_NAME", "")
            _env_key = f"VINV_ENGINE_TOOL_RESULT_COMPRESS_THRESHOLD_{_agent_name.upper()}"
            _COMPRESS_THRESHOLD = int(os.environ.get(
                _env_key,
                os.environ.get(
                    "VINV_ENGINE_TOOL_RESULT_COMPRESS_THRESHOLD",
                    str(_BROWSER_THRESHOLD if _agent_name in ("BrowserExecutor", "DesktopExecutor") else _DEFAULT_THRESHOLD),
                ),
            ))
            if len(result_str) <= _COMPRESS_THRESHOLD:
                return result_str

            from core.components.context_compressor.token_utils import (
                count_tokens as _count_tokens,
            )
            _result_tokens = _count_tokens(result_str)

            try:
                from core.components.context_compressor.model_context_registry import (
                    get_model_context_registry,
                )
                _window = get_model_context_registry().effective_input_limit(
                    getattr(self, "model_id", None)
                ) or 200_000
            except Exception:
                _window = 200_000
            _target_fraction = float(
                os.environ.get("VINV_ENGINE_TOOL_RESULT_TARGET_FRACTION", "0.25")
            )

            # Outputs larger than the model's real input window cannot be
            # meaningfully carried in context even after compression — and
            # compressing them wholesale costs hundreds of LLM calls. Instead:
            # preserve the COMPLETE output as an on-disk artifact and hand the
            # model a bounded digest (head/tail/diagnostic lines + artifact
            # path) with instructions to grep the artifact for what it needs.
            if _result_tokens > _window:
                try:
                    from core.components.context_compressor.log_artifact import (
                        store_and_digest,
                    )
                    digest = store_and_digest(
                        result_str,
                        label=f"{getattr(self, 'AGENT_NAME', 'agent')}-{tool_name}",
                        budget_tokens=int(_window * _target_fraction),
                    )
                    self.logger.info(
                        "tool_result_artifact | tool=%s | tokens=%d | digest_tokens=%d",
                        tool_name, _result_tokens, _count_tokens(digest),
                    )
                    return digest
                except Exception as _art_err:
                    self.logger.warning(
                        "tool_result_artifact_failed | tool=%s | error=%s",
                        tool_name, _art_err,
                    )
                    # fall through to LLM compression

            # Target: ~25% of the original (in TOKENS — count_tokens is the
            # single unit of measure everywhere; never chars-divided-by-magic),
            # capped at a fraction of the model's real input window. The
            # target is guidance for the compressor, not a truncation bound.
            _target_tokens = max(
                5000,
                min(_result_tokens // 4, int(_window * _target_fraction)),
            )
            try:
                from core.components.context_compressor.content_ingestion import (
                    ContentIngestionPipeline,
                )
                _pipe = ContentIngestionPipeline()
                _r = await _pipe.process(
                    content=result_str,
                    max_tokens=_target_tokens,
                    query=f"Tool '{tool_name}' result — preserve all element references, "
                          f"text content, interactive elements, and structural layout. "
                          f"Remove redundant ARIA roles and empty containers.",
                    goal="Compress browser state for ReAct trajectory context",
                    context_type="tool_result_compression",
                )
                self.logger.info(
                    "tool_result_compressed | tool=%s | original=%d | compressed=%d | ratio=%.1f%%",
                    tool_name, len(result_str), len(_r.content),
                    len(_r.content) / max(len(result_str), 1) * 100,
                )
                return _r.content
            except Exception as _e:
                self.logger.debug("tool_result_compress_failed | tool=%s | error=%s", tool_name, _e)
                return result_str
        
        def _strip_screenshot_from_result(self, result: Any, tool_name: str) -> Any:
            """Strip large screenshot/image data from tool results to prevent context bloat.
            
            This prevents base64 encoded screenshots from accumulating in conversation history,
            which can cause "input too long" errors with the LLM.
            
            Parameters
            ----------
            result : Any
                The tool result (usually a dict)
            tool_name : str
                Name of the tool that produced the result
                
            Returns
            -------
            Any
                The result with screenshot data replaced by a placeholder
            """
            if not isinstance(result, dict):
                return result
            
            # Keys that typically contain large image/screenshot data
            screenshot_keys = ['screenshot', 'image', 'base64', 'image_data', 'screenshot_data']
            
            result_copy = result.copy()
            stripped = False
            
            for key in screenshot_keys:
                if key in result_copy:
                    value = result_copy[key]
                    # Check if it looks like base64 data (long string, typically > 1000 chars)
                    if isinstance(value, str) and len(value) > 1000:
                        result_copy[key] = f"[screenshot captured - {len(value)} chars stripped from history]"
                        stripped = True
            
            if stripped:
                logger = logging.getLogger(f"vinv_engine.agents.{self.AGENT_NAME}")
                logger.info(f"🗜️ Stripped screenshot data from {tool_name} result to prevent context bloat")
            
            return result_copy

        def _build_dynamic_tool_list(self) -> str:
            """Build a formatted listing of ALL tools currently available to this agent.

            Reads from self.generate.tools (the final merged dict that DSPy ReAct
            uses at call time) so the listing always reflects dynamically-injected
            tools like VLM inspectors.

            Returns a multi-line string suitable for embedding in prompts.
            """
            tools = getattr(self.generate, 'tools', {})
            if not tools:
                return "═══ YOUR TOOLS ═══\nNo tools currently available."

            excluded = {'finish'}
            tool_names = sorted(
                name for name in tools if name not in excluded
            )
            if not tool_names:
                return "═══ YOUR TOOLS ═══\nNo tools currently available."

            lines = [f"═══ YOUR {len(tool_names)} TOOLS ═══"]
            for name in tool_names:
                tool = tools[name]
                doc = getattr(tool, '__doc__', '') or ''
                one_liner = ''
                if doc:
                    first_line = doc.strip().split('\n')[0].strip()
                    if first_line:
                        one_liner = f" — {first_line}"
                lines.append(f"  {name}(){one_liner}")

            lines.append("")
            lines.append(
                "NOTE: The above is the COMPLETE list of tools available to you. "
                "You CAN and SHOULD call any of these tools directly by name."
            )
            return "\n".join(lines)

        def _resolve_system_prompt(self) -> str:
            """Return system_prompt with {DYNAMIC_TOOL_LIST} replaced by actual tools."""
            dynamic_tools = self._build_dynamic_tool_list()
            return self.system_prompt.replace("{DYNAMIC_TOOL_LIST}", dynamic_tools)

        def _rebuild_react_signature(self):
            """Rebuild the ReAct internal signature to reflect the current tool set.

            DSPy's ReAct.__init__ bakes tool descriptions and a Literal type
            constraint on ``next_tool_name`` at construction time.  When tools
            are injected later (e.g. VLM inspectors via _vinv_engine_additional_tools),
            the signature becomes stale: the LLM never sees the new tools in its
            instructions and cannot select them because the Literal type excludes
            them.

            This method re-derives the instruction block and Literal constraint
            from ``self.generate.tools`` (the live, merged dict) and patches
            ``self.generate.react`` in-place so the next ReAct loop sees ALL
            tools.
            """
            from typing import Literal as _Literal
            _logger = logging.getLogger(f"vinv_engine.agents.{self.AGENT_NAME}")

            try:
                from dspy.adapters.types.tool import Tool as _DspyTool
            except ImportError:
                _logger.warning("Could not import dspy.adapters.types.tool.Tool — skipping signature rebuild")
                return

            react_module = self.generate  # dspy.ReAct instance
            if not hasattr(react_module, 'react') or not hasattr(react_module, 'tools'):
                _logger.debug("ReAct module missing .react or .tools — skipping signature rebuild")
                return

            tools = react_module.tools
            if not tools:
                return

            # Wrap raw callables into DSPy Tool objects for consistent formatting
            wrapped_tools = {}
            for name, t in tools.items():
                if isinstance(t, _DspyTool):
                    wrapped_tools[name] = t
                elif callable(t):
                    try:
                        wrapped_tools[name] = _DspyTool(t)
                    except Exception as e:
                        _logger.warning(f"Could not wrap tool '{name}' as DSPy Tool: {e}")
                        wrapped_tools[name] = t
                else:
                    wrapped_tools[name] = t

            # Rebuild instruction block (mirrors ReAct.__init__ logic)
            sig = react_module.signature
            inputs = ", ".join([f"`{k}`" for k in sig.input_fields.keys()])
            outputs = ", ".join([f"`{k}`" for k in sig.output_fields.keys()])

            # Inject the agent's SYSTEM_PROMPT into the signature instructions
            # so the LLM receives full behavioral guidance (strategy, rules,
            # interaction patterns) as part of its system context.
            resolved_prompt = self._resolve_system_prompt()

            instr = []
            if resolved_prompt and resolved_prompt.strip():
                instr.append(resolved_prompt.strip())
                instr.append("")
            if sig.instructions:
                instr.append(f"{sig.instructions}\n")
            instr.extend([
                f"You are an Agent. In each episode, you will be given the fields {inputs} as input. And you can see your past trajectory so far.",
                f"Your goal is to use one or more of the supplied tools to collect any necessary information for producing {outputs}.\n",
                "To do this, you will interleave next_thought, next_tool_name, and next_tool_args in each turn, and also when finishing the task.",
                "After each tool call, you receive a resulting observation, which gets appended to your trajectory.\n",
                "When writing next_thought, you may reason about the current situation and plan for future steps.",
                "When selecting the next_tool_name and its next_tool_args, the tool must be one of:\n",
            ])

            for idx, tool in enumerate(wrapped_tools.values()):
                instr.append(f"({idx + 1}) {tool}")
            instr.append("When providing `next_tool_args`, the value inside the field must be in JSON format")

            # Build the new react_signature
            new_react_signature = (
                dspy.Signature({**sig.input_fields}, "\n".join(instr))
                .append("trajectory", dspy.InputField(), type_=str)
                .append("next_thought", dspy.OutputField(), type_=str)
                .append("next_tool_name", dspy.OutputField(), type_=_Literal[tuple(wrapped_tools.keys())])
                .append("next_tool_args", dspy.OutputField(), type_=dict[str, Any])
            )

            # Patch the inner Predict module's signature
            react_module.react.signature = new_react_signature
            # Update the tool dict with properly wrapped tools
            react_module.tools = wrapped_tools

            _logger.info(
                f"🔄 Rebuilt ReAct signature with {len(wrapped_tools)} tools: "
                f"{sorted(wrapped_tools.keys())}"
            )

        def _create_bound_tools(self):
            """Create bound tool functions for ReAct."""
            bound_tools = {}
            
            # Create a mapping of tool functions to their names
            tool_map = {tool: tool.__name__ for tool in self._tools_list if hasattr(tool, '__name__')}
            
            _default_tool_timeout = int(get_timeout_seconds("agent.tool_call"))
            for tool_func, tool_name in tool_map.items():
                # Create a generic wrapper for each tool
                TOOL_CALL_TIMEOUT = _default_tool_timeout

                def make_bound_tool(func, name):
                    async def bound_tool(*args, **kwargs):
                        tool_start = time.time()
                        logger = logging.getLogger(f"vinv_engine.agents.{self.AGENT_NAME}")

                        if self._cancellation_flag and self._cancellation_flag.is_set():
                            logger.info(f"[🛠️ TOOL CALL] {name} SKIPPED | runtime shutting down")
                            return f"Tool {name} skipped: runtime is shutting down."

                        per_tool_timeout = getattr(func, '_tool_timeout', TOOL_CALL_TIMEOUT)
                        logger.info(f"[🛠️ TOOL CALL] {name} START | args={str(args)} | kwargs={str(kwargs)}")
                        try:
                            # Run sync tool function off the event loop.
                            result = await asyncio.wait_for(
                                asyncio.to_thread(func, *args, **kwargs),
                                timeout=per_tool_timeout,
                            )
                            tool_duration = time.time() - tool_start

                            # Check cancellation after tool returns
                            if self._cancellation_flag and self._cancellation_flag.is_set():
                                logger.info(f"[🛠️ TOOL CALL] {name} CANCELLED after completion")
                                return f"Tool {name} cancelled: runtime is shutting down."

                            # Strip screenshot data before converting to string for history
                            result_for_history = self._strip_screenshot_from_result(result, name)

                            # Convert sets to lists for JSON serialization
                            def convert_sets_to_lists(obj):
                                if isinstance(obj, set):
                                    return list(obj)
                                elif isinstance(obj, dict):
                                    return {k: convert_sets_to_lists(v) for k, v in obj.items()}
                                elif isinstance(obj, list):
                                    return [convert_sets_to_lists(item) for item in obj]
                                return obj

                            serializable_result = convert_sets_to_lists(result_for_history)
                            result_str = json.dumps(serializable_result, indent=2) if isinstance(serializable_result, dict) else str(serializable_result)

                            # Compress large tool results (async — no thread hops)
                            result_str = await self._truncate_tool_result(result_str, name)

                            logger.info(f"[🛠️ TOOL CALL] {name} COMPLETE | duration={tool_duration:.3f}s | result_length={len(result_str)}")
                            return result_str
                        except asyncio.TimeoutError:
                            tool_duration = time.time() - tool_start
                            logger.error(
                                f"[🛠️ TOOL CALL] {name} TIMEOUT after {per_tool_timeout}s | "
                                f"duration={tool_duration:.3f}s — try a different approach"
                            )
                            return (
                                f"Error in {name}: Tool call timed out after {per_tool_timeout} seconds. "
                                f"The operation took too long. Try a simpler query or different approach."
                            )
                        except Exception as e:
                            tool_duration = time.time() - tool_start
                            logger.error(f"[🛠️ TOOL CALL] {name} ERROR | error={str(e)} | duration={tool_duration:.3f}s")
                            return f"Error in {name}: {str(e)}"

                    # Preserve function signature for DSPy
                    bound_tool.__name__ = name
                    bound_tool.__doc__ = func.__doc__
                    # Resolve hints on the original callable so DSPy Tool() / get_type_hints succeed.
                    try:
                        bound_tool.__annotations__ = get_type_hints(
                            func, globalns=func.__globals__, localns=None
                        )
                    except Exception:
                        bound_tool.__annotations__ = {}
                    # Expose the WRAPPED tool's real signature to DSPy. Without this, DSPy
                    # introspects bound_tool's own ``(*args, **kwargs)`` signature and (a)
                    # advertises bogus ``args``/``kwargs`` params to the LLM — which then emits
                    # ``{"args": [...], "kwargs": {...}}`` and fails with "unexpected keyword
                    # argument 'args'", and (b) sets has_kwargs=True, disabling the arg-filter
                    # patch above. Copying the real signature makes DSPy advertise the actual
                    # parameter names (session_name, keystrokes, ...).
                    try:
                        bound_tool.__signature__ = inspect.signature(func)
                    except (ValueError, TypeError):
                        pass

                    return bound_tool
                
                bound_tools[tool_name] = make_bound_tool(tool_func, tool_name)
            
            return bound_tools

        def _prepare_for_execution(self, **kwargs) -> dict:
            """Hook for subclasses to prepare tool-specific state before execution.
            
            Subclasses can override this to handle tool-specific setup (e.g., terminal sessions).
            Returns a dict with any additional context needed for execution.
            """
            return {}

        def _is_context_length_error(self, error: Exception) -> bool:
            """Check if error is a context length error.

            Uses litellm's typed exception when available. Also treats as
            context-length when the error message indicates token/context
            overflow (e.g. AWS Bedrock can return BadRequestError with
            "prompt is too long" instead of ContextWindowExceededError).
            """
            if LiteLLMContextWindowError and isinstance(error, LiteLLMContextWindowError):
                return True
            msg = (getattr(error, "message", None) or str(error) or "").lower()
            exc = error
            for _ in range(5):
                if exc is None:
                    break
                msg = msg + " " + (getattr(exc, "message", None) or str(exc) or "").lower()
                exc = getattr(exc, "__cause__", None)
            context_patterns = (
                "prompt is too long",
                "context length",
                "context length exceeded",
                "context_window",
                "token limit exceeded",
                "maximum context length",
                "tokens > ",
                "exceeds the maximum",
                "input is too long",
            )
            return any(p in msg for p in context_patterns)
        
        @property
        def _PREEMPTIVE_MODEL_LIMIT(self) -> int:
            """Hard model context window (200k).  This is the absolute max
            the API accepts.  Content up to this limit can be sent directly."""
            from core.components.context_compressor.model_context_registry import (
                get_model_context_registry,
            )
            model_id = getattr(self, "model_id", None)
            limit = get_model_context_registry().get_limit(model_id)
            return limit if limit is not None else 200_000

        # Per-agent preemptive compression thresholds (tokens).
        # Browser agents produce massive tool results (accessibility trees,
        # VLM analyses, screenshot descriptions) that accumulate much faster
        # than terminal/code agents. Lower threshold = earlier compression.
        _AGENT_COMPRESS_THRESHOLDS: dict = {
            # With a 200K model, reserve 80K for output + tools + overhead.
            # Compress only when input would leave < 80K for the model to
            # generate output.  The old thresholds (90K browser, 125K default)
            # triggered compression on 100K inputs that fit easily in 200K,
            # wasting 220-880s per unnecessary compression.
            #
            # 200K model − 80K output reserve = 120K threshold.
            # All agents use the same threshold — the model capacity is the
            # same regardless of agent type.  Browser agents produce larger
            # tool results, but the model can still handle 120K input.
        }

        @property
        def _PREEMPTIVE_COMPRESS_THRESHOLD(self) -> int:
            """Pre-emptive compression threshold (tokens).

            Derived from model capacity: model_limit − output_reserve.
            With 200K model and 80K output reserve, threshold = 120K.
            Only compress when input actually can't fit alongside output.

            Per-agent override via ``VINV_ENGINE_COMPRESS_THRESHOLD_{AGENT_NAME}``.
            """
            # Check per-agent env var first
            agent_name = getattr(self, "AGENT_NAME", "")
            env_key = f"VINV_ENGINE_COMPRESS_THRESHOLD_{agent_name.upper()}"
            env_val = os.environ.get(env_key, "").strip()
            if env_val:
                try:
                    return int(env_val)
                except ValueError:
                    pass

            # Check built-in per-agent thresholds
            if agent_name in self._AGENT_COMPRESS_THRESHOLDS:
                return self._AGENT_COMPRESS_THRESHOLDS[agent_name]

            # Derive from model capacity: 60% of model for input, 40% reserved for output.
            # With 200K model: threshold = 120K, output reserve = 80K.
            # Only compress when input would exceed 60% of model capacity.
            _output_reserve_pct = float(os.environ.get("VINV_ENGINE_OUTPUT_RESERVE_PCT", "0.40"))
            try:
                from core.components.context_compressor.model_context_registry import (
                    get_model_context_registry,
                )
                _model_limit = get_model_context_registry().get_limit() or 200_000
            except Exception:
                _model_limit = 200_000
            _derived = int(_model_limit * (1.0 - _output_reserve_pct))  # 200K * 0.6 = 120K

            # Allow config override but never go below model-derived threshold
            from core.components.common.model_context import _cfg
            try:
                _configured = int(_cfg().get("preemptive_compress_threshold", str(_derived)))
            except Exception:
                _configured = _derived
            return max(_configured, _derived)

        def _measure_tool_tokens(self) -> int:
            """Count actual tokens consumed by tool definitions."""
            from core.components.context_compressor.token_utils import count_tokens
            tools = getattr(self.generate, "tools", {}) or {}
            if not tools:
                return 0
            total = 0
            for tool in tools.values() if isinstance(tools, dict) else tools:
                try:
                    tool_str = str(getattr(tool, "desc", "")) + str(getattr(tool, "args", ""))
                    total += count_tokens(tool_str)
                except Exception:
                    total += 500
            return total

        _PREEMPTIVE_SYSTEM_OVERHEAD_BUFFER = 2000

        @property
        def _PREEMPTIVE_SYSTEM_OVERHEAD(self) -> int:
            """Actual system prompt tokens + chat-template buffer.

            The old static value (5000) underestimated by 30-50% for agents
            with large system prompts, causing 210k-token prompts to slip
            past the 200k preemptive guard.  Compute the real value once and
            cache it; invalidate after system prompt compression.
            """
            cached = getattr(self, "_cached_system_overhead", None)
            if cached is not None:
                return cached
            try:
                from core.components.context_compressor.token_utils import count_tokens
                sp = getattr(self, "system_prompt", None) or ""
                tokens = count_tokens(sp) + self._PREEMPTIVE_SYSTEM_OVERHEAD_BUFFER
            except Exception:
                tokens = int(os.environ.get("VINV_ENGINE_PREEMPTIVE_SYSTEM_OVERHEAD", "5000"))
            self._cached_system_overhead = tokens
            return tokens

        _system_prompt_compressed: bool = False
        _original_system_prompt: Optional[str] = None

        async def _compress_system_prompt(self, budget_tokens: int | None = None) -> bool:
            """Use an LLM to compress the system prompt when context is too large.

            Preserves critical behavioral constraints (tool usage rules, safety,
            output format) while stripping verbose examples, repeated guidance,
            and protocol boilerplate.  The compressed prompt replaces
            ``self.system_prompt`` and the ReAct signature is rebuilt.

            Returns True if compression was performed, False if skipped.
            """
            logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")

            if self._system_prompt_compressed:
                logger.debug("System prompt already compressed — skipping")
                return False

            prompt_text = self.system_prompt
            if not prompt_text or len(prompt_text) < 500:
                return False

            self._original_system_prompt = prompt_text

            from core.components.context_compressor.token_utils import count_tokens

            current_tokens = count_tokens(prompt_text)
            target_tokens = budget_tokens or max(current_tokens // 3, 800)

            logger.info(
                "Compressing system prompt: %d chars (%d tokens) → target %d tokens",
                len(prompt_text), current_tokens, target_tokens,
            )

            try:
                from core.components.context_compressor.content_ingestion import (
                    ContentIngestionPipeline,
                )
                pipe = ContentIngestionPipeline()
                result = await pipe.process(
                    content=prompt_text,
                    max_tokens=target_tokens,
                    query="Compress agent system prompt for context budget",
                    goal=(
                        "KEEP: agent role identity, critical behavioral rules, "
                        "output format requirements, safety constraints, tool selection "
                        "guidance. DROP: verbose examples, repeated explanations, "
                        "decorative formatting, protocol boilerplate that the agent "
                        "already knows from tool docstrings."
                    ),
                    context_type="context",
                )
                compressed = result.content
                if compressed and len(compressed) > 100:
                    self.system_prompt = compressed
                    self._system_prompt_compressed = True
                    self._cached_system_overhead = None  # invalidate overhead cache
                    self._rebuild_react_signature()
                    logger.info(
                        "System prompt compressed: %d → %d chars (%.0f%% reduction)",
                        len(prompt_text), len(compressed),
                        (1 - len(compressed) / len(prompt_text)) * 100,
                    )
                    return True
                else:
                    logger.warning("System prompt compression produced near-empty result — keeping original")
                    return False
            except Exception as exc:
                logger.warning("System prompt compression failed: %s", exc)
                return False

        def _restore_system_prompt(self) -> None:
            """Restore the original uncompressed system prompt."""
            if self._original_system_prompt is not None:
                self.system_prompt = self._original_system_prompt
                self._system_prompt_compressed = False
                self._original_system_prompt = None
                self._cached_system_overhead = None  # invalidate overhead cache
                self._rebuild_react_signature()

        # Agents whose tool results contain large snapshot/accessibility trees.
        # For these, old snapshots are collapsed to compact summaries.
        _SNAPSHOT_HEAVY_AGENTS = {"BrowserExecutor", "DesktopExecutor"}

        # How many recent snapshots to keep in full (older ones get collapsed)
        _SNAPSHOT_KEEP_FULL = int(os.environ.get("VINV_ENGINE_SNAPSHOT_KEEP_FULL", "2"))

        def _prune_old_snapshots(self, history: str) -> str:
            """For browser/desktop agents: collapse old snapshot accessibility trees.

            Keeps the last N snapshots in full, replaces older ones with a one-line
            summary (URL + action taken). This prevents unbounded accumulation of
            30-50K accessibility trees across ReAct steps.

            Non-browser agents are unaffected (returns history unchanged).
            """
            agent_name = getattr(self, "AGENT_NAME", "")
            if agent_name not in self._SNAPSHOT_HEAVY_AGENTS:
                return history
            if not history or len(history) < 50_000:
                return history  # too small to bother

            import re

            # Find all snapshot blocks in the history.
            # Snapshots appear as JSON with "snapshot" key containing the
            # accessibility tree text, OR as inline formatted snapshot text
            # starting with patterns like "Page: ... | Viewport: ..."
            #
            # Strategy: find all large blocks (>5K chars) that look like
            # browser tool results and keep only the last N in full.
            # Older ones get replaced with: [Snapshot at URL — N elements]

            # Split history by tool call boundaries (each starts with a tool name)
            # DSPy ReAct history format: alternating Thought/Action/Observation blocks
            sections = re.split(r'(?=\[🛠️ TOOL CALL\]|\{"success")', history)
            if len(sections) <= self._SNAPSHOT_KEEP_FULL + 1:
                return history  # not enough sections to prune

            # Find sections that contain snapshot/accessibility data
            snapshot_indices = []
            for i, section in enumerate(sections):
                # Detect snapshot-heavy sections by size and content markers
                if len(section) > 5000 and (
                    '"snapshot"' in section
                    or 'ref=' in section
                    or 'Interactive elements' in section
                    or 'role=' in section
                ):
                    snapshot_indices.append(i)

            if len(snapshot_indices) <= self._SNAPSHOT_KEEP_FULL:
                return history  # not enough snapshots to prune

            # Keep last N, collapse the rest
            to_collapse = snapshot_indices[:-self._SNAPSHOT_KEEP_FULL]
            total_saved = 0

            for idx in to_collapse:
                original = sections[idx]
                original_len = len(original)

                # Extract URL and action from the section for the summary
                url_match = re.search(r'"url":\s*"([^"]+)"', original)
                url = url_match.group(1) if url_match else "unknown"
                desc_match = re.search(r'"description":\s*"([^"]+)"', original)
                desc = desc_match.group(1) if desc_match else "browser action"

                # Count refs for element count
                ref_count = len(re.findall(r'ref=\d+', original))

                # Replace with compact summary
                sections[idx] = (
                    f'[Previous snapshot: {desc} at {url} — '
                    f'{ref_count} interactive elements, '
                    f'{original_len} chars collapsed]'
                )
                total_saved += original_len - len(sections[idx])

            if total_saved > 10_000:
                _logger = logging.getLogger(f"vinv_engine.agents.{agent_name}")
                _logger.info(
                    f"🗜️ Pruned {len(to_collapse)} old snapshots, "
                    f"saved {total_saved:,} chars "
                    f"(kept last {self._SNAPSHOT_KEEP_FULL} in full)"
                )

            return "".join(sections)

        def _estimate_total_prompt_tokens(self, generate_kwargs: dict) -> int:
            """Estimate total prompt tokens (instruction + history + tools + system overhead)."""
            from core.components.context_compressor.token_utils import count_tokens
            instruction = generate_kwargs.get("instruction", "")
            history = generate_kwargs.get("conversation_history", "")
            return (
                count_tokens(instruction)
                + count_tokens(history)
                + self._measure_tool_tokens()
                + self._PREEMPTIVE_SYSTEM_OVERHEAD
            )

        async def _preemptive_context_guard(self, generate_kwargs: dict) -> dict:
            """Two-tier pre-emptive compression.

            Hard limit: 200k tokens (API max).  Pre-emptive threshold: 130k.
            - Total < 130k: pass through, no compression.
            - Total 130k–200k: compress instruction to fit within 130k.
              The call still uses the COMPRESSED version (ready immediately
              since we compress now), but the target is advisory — we aim
              for 130k but accept anything under 200k.
            - Total > 200k: must compress to fit under 200k hard limit.
            """
            try:
                from core.components.context_compressor.token_utils import count_tokens

                instruction = generate_kwargs.get("instruction", "")
                history = generate_kwargs.get("conversation_history", "")

                instr_tokens = count_tokens(instruction)
                hist_tokens = count_tokens(history)
                tool_tokens = self._measure_tool_tokens()

                total = instr_tokens + hist_tokens + tool_tokens + self._PREEMPTIVE_SYSTEM_OVERHEAD
                threshold = self._PREEMPTIVE_COMPRESS_THRESHOLD  # 130k
                C = self._PREEMPTIVE_MODEL_LIMIT                 # 200k

                # Below threshold: no compression needed
                if total <= threshold:
                    return generate_kwargs

                # Between threshold and hard limit: compress instruction to
                # bring total under threshold.  Target is advisory.
                instruction_budget = threshold - hist_tokens - tool_tokens - self._PREEMPTIVE_SYSTEM_OVERHEAD

                if instruction_budget <= 0:
                    logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
                    logger.warning(
                        "Pre-emptive guard: history (%d) + tools (%d) + overhead (%d) "
                        "already consume >50%% of context (%d). "
                        "Trying system prompt compression.",
                        hist_tokens, tool_tokens, self._PREEMPTIVE_SYSTEM_OVERHEAD, C,
                    )
                    if not self._system_prompt_compressed:
                        await self._compress_system_prompt()
                    return generate_kwargs

                if instr_tokens <= instruction_budget:
                    return generate_kwargs

                logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
                logger.warning(
                    "Pre-emptive guard: instruction %d tokens exceeds budget %d "
                    "(C=%d, history=%d, tools=%d, overhead=%d). "
                    "Compressing instruction via AIOC.",
                    instr_tokens, instruction_budget, C,
                    hist_tokens, tool_tokens, self._PREEMPTIVE_SYSTEM_OVERHEAD,
                )

                from core.components.context_compressor.content_ingestion import (
                    ContentIngestionPipeline,
                )
                pipeline = ContentIngestionPipeline()
                result = await pipeline.process(
                    content=instruction,
                    max_tokens=instruction_budget,
                    query="Compress task instruction to fit model context window",
                    goal=(
                        "Preserve task description, goal, dependency context, "
                        "file paths, architect guidance, and all critical details. "
                        "This is COMPRESSION not summarization."
                    ),
                    context_type="context",
                )
                compressed_tokens = count_tokens(result.content)
                if compressed_tokens == 0 and instr_tokens > 0:
                    logger.warning(
                        "Pre-emptive guard: compression produced empty result, "
                        "keeping original instruction (%d tokens).",
                        instr_tokens,
                    )
                    return generate_kwargs

                generate_kwargs = dict(generate_kwargs)
                generate_kwargs["instruction"] = result.content
                logger.info(
                    "Pre-emptive compression: instruction %d -> %d tokens",
                    instr_tokens, compressed_tokens,
                )

                new_total = compressed_tokens + hist_tokens + tool_tokens + self._PREEMPTIVE_SYSTEM_OVERHEAD
                if new_total > C and not self._system_prompt_compressed:
                    logger.info(
                        "Pre-emptive guard: still over hard limit (%d > %d) "
                        "after instruction compression — compressing system prompt.",
                        new_total, C,
                    )
                    await self._compress_system_prompt(
                        budget_tokens=max(C - compressed_tokens - hist_tokens - tool_tokens - 5000, 500),
                    )
            except Exception as exc:
                logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
                logger.warning(f"Pre-emptive guard failed (proceeding anyway): {exc}")
            return generate_kwargs

        async def _compress_conversation_history(
            self,
            conversation_history: str,
            instruction: str,
            compression_ratio: float = 0.5
        ) -> str:
            """Compress conversation history using AgenticCompressor."""
            if not conversation_history or not conversation_history.strip():
                return conversation_history
            
            current_tokens = len(conversation_history) // 4
            target_tokens = int(current_tokens * compression_ratio)
            
            logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
            logger.info(f"🗜️ Compressing conversation history...")
            logger.info(f"   Original: {current_tokens} tokens → Target: {target_tokens} tokens ({int(compression_ratio * 100)}%)")
            
            if self._compressor:
                # Extract keywords from instruction
                words = instruction.lower().split()
                common_words = {'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'}
                keywords = [w.strip('.,!?;:') for w in words if w not in common_words and len(w) > 3][:10]
                
                task_context = {
                    'actor_name': self.AGENT_NAME,
                    'goal': instruction,
                    'query': instruction,
                    'priority_keywords': keywords,
                    'content_type': 'conversation'
                }
                
                try:
                    compressed = await self._compressor.compress(
                        content=conversation_history,
                        task_context=task_context,
                        target_tokens=target_tokens
                    )
                    logger.info(f"✅ Intelligently compressed: {len(conversation_history)} → {len(compressed)} chars")
                    return compressed
                except Exception as e:
                    logger.error(f"❌ Compression failed: {e}, using simple truncation")
            
            # Fallback: use UnifiedCompressor with recursive chunking
            try:
                from core.components.context_compressor.unified_compression import (
                    UnifiedCompressor,
                )
                uc = UnifiedCompressor()
                compressed = await uc.compress(
                    conversation_history,
                    max_tokens=target_tokens,
                    goal=(
                        "Preserve all file paths, URLs, error messages, tool results, "
                        "and final outputs. Compress verbose intermediate reasoning."
                    ),
                )
                logger.info(f"✅ UnifiedCompressor fallback: {len(conversation_history)} → {len(compressed)} chars")
                return compressed
            except Exception as uc_err:
                logger.warning(f"⚠️  UnifiedCompressor fallback also failed: {uc_err}; returning full context")

            return conversation_history

        async def aforward(
            self,
            instruction: str,
            conversation_history: str = "",
            session_id: Optional[str] = None,
            model_id: Optional[str] = None,
            **kwargs
        ) -> AsyncGenerator[dict, Any]:
            """Async generator version of forward that yields conversational events."""
            logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
            logger.info(f"🚀 {self.AGENT_NAME} starting task execution via aforward")
            yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I am starting task execution for {self.AGENT_NAME}"}
            
            log_agent_model_usage(self.AGENT_NAME, "aforward")

            self.model_id = model_id

            # Restore system prompt if it was compressed in a previous execution.
            self._restore_system_prompt()

            # Always call _prepare_for_execution so subclasses can pick up
            # per-task kwargs (_parallel_task_id, session isolation, etc.)
            # even when tools were pre-warmed at startup.
            _prewarmed = getattr(self, "_tools_prewarmed", False)
            if _prewarmed:
                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "Updating execution context for this task (tools pre-warmed)"}
            else:
                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I am preparing execution context"}

            _prep_result = self._prepare_for_execution(**kwargs)
            if inspect.isawaitable(_prep_result):
                execution_context = await _prep_result
            else:
                execution_context = _prep_result or {}

            if _prewarmed:
                if hasattr(self, "_engine") and self._engine and hasattr(self._engine, "is_started") and self._engine.is_started:
                    try:
                        from core.components.tools.browser.browser_tools_v2 import set_browser_engine
                        set_browser_engine(self._engine)
                    except ImportError:
                        pass
            else:
                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I have prepared the execution context"}

            # Rebuild and merge tools only if not pre-warmed.
            # Pre-warming (vinv_engine on_start) already built + merged tools.
            logger_local = logging.getLogger(f"vinv_engine.agents.{self.AGENT_NAME}")
            if _prewarmed:
                tool_count = len(getattr(self.generate, 'tools', {}))
                logger_local.info(f"🔧 Tools pre-warmed at startup ({tool_count} tools) — skipping rebuild")
                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Tools pre-warmed ({tool_count} tools available)"}
            else:
                new_tools = self._create_bound_tools()
                if hasattr(self.generate, 'tools') and 'finish' in self.generate.tools:
                    new_tools['finish'] = self.generate.tools['finish']
                logger_local.debug(f"🔍 [TOOL MERGE DEBUG] Checking _vinv_engine_additional_tools | hasattr={hasattr(self, '_vinv_engine_additional_tools')}")
                if hasattr(self, '_vinv_engine_additional_tools'):
                    logger_local.debug(f"🔍 [TOOL MERGE DEBUG] _vinv_engine_additional_tools exists | value={self._vinv_engine_additional_tools} | type={type(self._vinv_engine_additional_tools)} | len={len(self._vinv_engine_additional_tools) if self._vinv_engine_additional_tools else 0}")
                    if self._vinv_engine_additional_tools:
                        tools_before = len(new_tools)
                        for tool in self._vinv_engine_additional_tools:
                            tool_name = getattr(tool, 'name', None) or getattr(tool, '__name__', None) or str(tool)
                            logger_local.debug(f"🔍 [TOOL MERGE DEBUG] Processing tool: {tool_name} | already_in_dict={tool_name in new_tools}")
                            if tool_name not in new_tools:
                                new_tools[tool_name] = tool
                                logger_local.debug(f"🔍 [TOOL MERGE DEBUG] Added tool {tool_name} to ReAct dict")
                        tools_after = len(new_tools)
                        logger_local.info(f"🔧 Merged {len(self._vinv_engine_additional_tools)} injected tools into ReAct | before={tools_before} | after={tools_after} | added={tools_after - tools_before}")
                    else:
                        logger_local.debug(f"🔍 [TOOL MERGE DEBUG] _vinv_engine_additional_tools is empty/None")
                else:
                    logger_local.debug(f"🔍 [TOOL MERGE DEBUG] _vinv_engine_additional_tools attribute does not exist on {self.AGENT_NAME}")
                self.generate.tools = new_tools
                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I have updated tools, now have {len(new_tools)} tools available"}

            # Rebuild the ReAct signature so the LLM sees all merged tools
            # (including dynamically-injected VLM tools) in its instruction
            # and can select them via the Literal type constraint.
            self._rebuild_react_signature()

            # Inject dynamic tool listing into the instruction when the agent's
            # system prompt contains {DYNAMIC_TOOL_LIST}. This ensures agents
            # always know about ALL their tools (including dynamically-injected ones
            # like VLM inspectors) without hardcoding tool names in prompts.
            if "{DYNAMIC_TOOL_LIST}" in self.system_prompt:
                dynamic_tool_section = self._build_dynamic_tool_list()
                instruction = f"{dynamic_tool_section}\n\n{instruction}"
                logger_local.info(
                    f"📋 Injected dynamic tool list ({len(dynamic_tool_section)} chars) "
                    f"into instruction for {self.AGENT_NAME}"
                )

            # Inject memory hints from past tasks if available in kwargs.
            # These come from the coordinator's prefetch cache and give the
            # executor knowledge of past failures/successes on similar tasks.
            _mem_hints = kwargs.get("memory_hints", "")
            if _mem_hints and isinstance(_mem_hints, str) and len(_mem_hints) > 20:
                instruction = (
                    "## MEMORY CONTEXT (past experience — may not be 100% accurate for current task):\n"
                    "Use these learnings to avoid known pitfalls and repeat proven strategies.\n"
                    "If current observations conflict with memories, PREFER current observations "
                    "and note the discrepancy.\n"
                    f"{_mem_hints}\n"
                    "## END MEMORY CONTEXT\n\n"
                    f"{instruction}"
                )
                logger_local.info(
                    f"🧠 Injected memory hints ({len(_mem_hints)} chars) into {self.AGENT_NAME}"
                )

            # Automatic compression retry logic with trajectory preservation
            current_history = conversation_history
            _compression_ratio_env = float(os.environ.get("VINV_ENGINE_COMPRESSION_RATIO", "0.7"))
            compression_ratio = _compression_ratio_env  # Start with configured ratio
            trajectory = ""  # Accumulated ReAct steps from current iteration
            logger = logging.getLogger(f"{__name__}.{self.AGENT_NAME}")
            
            for attempt in range(self._max_compression_retries + 1):
                try:
                    if attempt == 0:
                        logger.info(f"🚀 Executing {self.AGENT_NAME} (attempt {attempt + 1})")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I am executing {self.AGENT_NAME} (attempt {attempt + 1})"}
                    else:
                        logger.info(f"🔄 Retry {attempt}/{self._max_compression_retries} within same iteration")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I am retrying execution (attempt {attempt + 1}/{self._max_compression_retries})"}
                        logger.info(f"   Preserving {len(trajectory)} chars of trajectory, compressing old history")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I am preserving {len(trajectory)} chars of trajectory and compressing old history"}
                    
                    # Combine trajectory (from this iteration) with history
                    combined_history = current_history + ("\n\n" + trajectory if trajectory else "")

                    # Prune old browser snapshots — keep last N in full, collapse older
                    combined_history = self._prune_old_snapshots(combined_history)

                    yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I am combining conversation history ({len(current_history)} chars) with trajectory ({len(trajectory)} chars)"}
                    
                    # Build generate kwargs with execution context
                    generate_kwargs = {
                        "instruction": instruction,
                        "conversation_history": combined_history,
                        **execution_context  # Include any tool-specific state from subclass
                    }
                    
                    # 🔴 A-TEAM FIX: Auto-populate missing signature input fields with defaults.
                    # DSPy's chat_adapter requires ALL input fields to be explicitly present
                    # even if they have defaults. Without this, agents with optional fields
                    # (e.g. DocumentationAgent's content_data, theme) crash on format_turn.
                    if hasattr(self, 'SIGNATURE_CLASS') and self.SIGNATURE_CLASS and hasattr(self.SIGNATURE_CLASS, 'input_fields'):
                        for field_name, field_info in self.SIGNATURE_CLASS.input_fields.items():
                            if field_name not in generate_kwargs:
                                field_default = getattr(field_info, 'default', None)
                                if field_default is not None:
                                    generate_kwargs[field_name] = field_default
                                    logger.debug(f"🔧 Auto-populated missing signature field '{field_name}' with default")

                    # Proactive total-prompt check: compress before first call if over threshold.
                    # Uses per-agent threshold (Browser=90k, Desktop=90k, default=125k).
                    if attempt == 0:
                        total_tokens = self._estimate_total_prompt_tokens(generate_kwargs)
                        threshold = self._PREEMPTIVE_COMPRESS_THRESHOLD
                        if total_tokens > threshold:
                            from core.components.context_compressor.token_utils import count_tokens
                            from core.components.context_compressor.content_ingestion import (
                                ContentIngestionPipeline,
                            )
                            instr_tokens = count_tokens(generate_kwargs.get("instruction", ""))
                            hist_tokens = count_tokens(generate_kwargs.get("conversation_history", ""))
                            tool_tokens = self._measure_tool_tokens()
                            overhead = self._PREEMPTIVE_SYSTEM_OVERHEAD
                            history_budget = threshold - instr_tokens - tool_tokens - overhead
                            if (
                                history_budget > 0
                                and hist_tokens > history_budget
                                and generate_kwargs.get("conversation_history")
                            ):
                                pipeline = ContentIngestionPipeline()
                                result = await pipeline.process(
                                    content=generate_kwargs["conversation_history"],
                                    max_tokens=history_budget,
                                    query="Compress conversation history to fit context window",
                                    goal=(
                                        "Preserve file paths, URLs, errors, tool results, final outputs. "
                                        "Compress verbose reasoning."
                                    ),
                                    context_type="context",
                                )
                                generate_kwargs = dict(generate_kwargs)
                                generate_kwargs["conversation_history"] = result.content
                                new_hist = count_tokens(result.content)
                                logger.info(
                                    "Proactive total-prompt compression: history %d -> %d tokens "
                                    "(total was %d > %d)",
                                    hist_tokens, new_hist, total_tokens, threshold,
                                )
                                logger.info(
                                    "proactive_context_compression_applied agent=%s total_tokens=%s "
                                    "threshold=%s history_before=%s history_after=%s",
                                    self.AGENT_NAME, total_tokens, threshold, hist_tokens, new_hist,
                                )
                                yield {
                                    "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}",
                                    "message": "Proactive context compression applied before first call",
                                }

                    generate_kwargs = await self._preemptive_context_guard(
                        generate_kwargs
                    )

                    yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I am calling the DSPy ReAct generate module"}

                    # Use callback mechanism to capture all internal thinking and ReAct steps.
                    # Drain the queue *concurrently* with the LM call: ReAct callbacks fire
                    # synchronously inside ``generate.acall``, but that whole loop is one
                    # ``await``. If we only drained after it returned, every per-iteration
                    # thinking event would land at the same millisecond at the end of the
                    # run — which is exactly what produced the "0 events for 7 minutes,
                    # then 36 events at once" pattern observed in the UI. Streaming the
                    # queue while the call is in flight makes per-iteration thinking and
                    # tool calls visible as they happen.
                    queue: asyncio.Queue[dict] = asyncio.Queue()
                    react_callback = self._ReActStreamCallback(queue, self.AGENT_NAME)

                    _lm_override = getattr(self, '_vinv_engine_lm_override', None)
                    _ctx_kwargs: dict = {"callbacks": [react_callback]}
                    if _lm_override:
                        _ctx_kwargs["lm"] = _lm_override

                    async def _run_call():
                        with dspy.context(**_ctx_kwargs):
                            return await self.generate.acall(**generate_kwargs)

                    call_task = asyncio.create_task(_run_call())

                    def _yield_message(msg):
                        if not msg:
                            return None
                        data = msg.get("data", {})
                        agent_data = data.get("data", "")
                        return {
                            "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}",
                            "message": agent_data if isinstance(agent_data, str) else str(agent_data),
                        }

                    # Stream queued ReAct events while the LM call is in flight.
                    while not call_task.done():
                        try:
                            message = await asyncio.wait_for(queue.get(), timeout=0.25)
                        except asyncio.TimeoutError:
                            continue
                        out = _yield_message(message)
                        if out is not None:
                            yield out

                    # Final drain of any events queued in the brief window between
                    # the last queue.get() poll and call_task completing.
                    while not queue.empty():
                        try:
                            message = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        out = _yield_message(message)
                        if out is not None:
                            yield out

                    # Surface call result or re-raise exception.
                    try:
                        result = call_task.result()
                    except Exception as gen_error:
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I encountered an error during generation: {str(gen_error)}"}
                        raise

                    yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I have received the result from the DSPy ReAct generate module"}
                    
                    if attempt > 0:
                        logger.info(f"✅ Success after {attempt} compression retries (trajectory preserved)!")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I have successfully completed after {attempt} compression retries"}
                    
                    skill_buffer = getattr(self.generate, "_skill_buffer", None)
                    if skill_buffer:
                        if hasattr(result, "_store") and isinstance(result._store, dict):
                            result._store["skill_buffer"] = skill_buffer

                    yield {"type": "result", "result": result, "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I am returning the execution result"}
                    return
                    
                except Exception as e:
                    error_type = type(e).__name__
                    error_message = str(e)

                    # Handle timeout errors
                    if (LiteLLMTimeout and isinstance(e, LiteLLMTimeout)) or "Timeout" in error_type or "timeout" in error_message.lower():
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I encountered a timeout error: {error_message}"}
                        raise RuntimeError(f"Language model request timed out: {error_message}") from e

                    # Handle parse errors with retry
                    if (AdapterParseError and isinstance(e, AdapterParseError)) or "AdapterParseError" in error_type:
                        _pe_max = int(os.environ.get("VINV_ENGINE_PARSE_ERROR_MAX_RETRIES", "3"))
                        _pe_attempt = getattr(self, "_parse_error_retry_count", 0)
                        if _pe_attempt < _pe_max:
                            self._parse_error_retry_count = _pe_attempt + 1
                            backoff = 3 * (2 ** _pe_attempt)
                            logger.warning(f"Parse error, retrying in {backoff}s (retry {_pe_attempt + 1}/{_pe_max}): {error_message}")
                            yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Parse error, retrying ({_pe_attempt + 1}/{_pe_max}): {error_message}"}
                            await asyncio.sleep(backoff)
                            continue
                        else:
                            self._parse_error_retry_count = 0
                            yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Parse error persists after {_pe_max} retries: {error_message}"}
                            raise RuntimeError(f"Failed to parse model response after {_pe_max} retries: {error_message}") from e

                    # Check if it's a rate limit error — retry with backoff
                    is_rate_limit = (
                        (LiteLLMRateLimitError and isinstance(e, LiteLLMRateLimitError))
                        or "ratelimit" in error_message.lower().replace(" ", "")
                        or "rate_limit" in error_message.lower()
                    )
                    if is_rate_limit:
                        _rl_max = int(os.environ.get("VINV_ENGINE_RATE_LIMIT_MAX_RETRIES", "6"))
                        _rl_attempt = getattr(self, "_rl_retry_count", 0)
                        if _rl_attempt < _rl_max:
                            self._rl_retry_count = _rl_attempt + 1
                            backoff = min(2 * (_rl_attempt + 1), 5)
                            logger.warning(f"Rate limit hit, backing off {backoff}s (retry {_rl_attempt + 1}/{_rl_max})")
                            yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Rate limited, waiting {backoff}s before retry ({_rl_attempt + 1}/{_rl_max})"}
                            await asyncio.sleep(backoff)
                            continue
                        else:
                            logger.error(f"Rate limit persists after {_rl_max} retries, giving up")
                            yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Rate limit persists after {_rl_max} retries"}
                            self._rl_retry_count = 0
                            raise

                    # Check if it's a context length error — match ANY exception
                    # type whose message contains context-length patterns, not
                    # just litellm.exceptions.BadRequestError.  Different LLM
                    # providers surface this error through different types.
                    is_context_error = self._is_context_length_error(e)
                    if is_context_error:
                        detected_by = "type" if (LiteLLMContextWindowError and isinstance(e, LiteLLMContextWindowError)) else "message"
                        logger.info(
                            "context_length_detected agent=%s detected_by=%s error_type=%s",
                            self.AGENT_NAME, detected_by, error_type,
                        )
                        # Teach the registry the provider's REAL numbers from
                        # this rejection (its enforced input limit and its own
                        # token count). Every later compression plan then uses
                        # ground truth instead of catalog/env guesses.
                        try:
                            from core.components.context_compressor.unified_compression import (
                                _parse_overflow_numbers,
                            )
                            from core.components.context_compressor.model_context_registry import (
                                get_model_context_registry,
                            )
                            _reported, _limit = _parse_overflow_numbers(e)
                            if _reported or _limit:
                                get_model_context_registry().record_overflow(
                                    getattr(self, "model_id", None), 0, _reported, _limit,
                                )
                        except Exception as _cal_err:
                            logger.debug("overflow calibration skipped: %s", _cal_err)
                    
                    if not is_context_error:
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I encountered an error: {error_type}: {error_message}"}
                        raise

                    _hist_empty = len(conversation_history or "") == 0
                    _traj_empty = len(trajectory or "") == 0
                    if _hist_empty and _traj_empty:
                        logger.warning(
                            "Context-length error with empty history AND trajectory — "
                            "attempting system prompt + instruction compression."
                        )
                        yield {
                            "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}",
                            "message": (
                                "Instruction exceeds context window (history=0, trajectory=0). "
                                "Compressing system prompt and instruction."
                            ),
                        }

                        _did_compress_sp = False
                        if not self._system_prompt_compressed:
                            _did_compress_sp = await self._compress_system_prompt()
                            if _did_compress_sp:
                                logger.info("System prompt compressed — retrying before instruction compression")
                                attempt += 1
                                continue

                        if instruction and len(instruction) > 500:
                            try:
                                from core.components.context_compressor.content_ingestion import (
                                    ContentIngestionPipeline,
                                )
                                _pipe = ContentIngestionPipeline()
                                _target = max(len(instruction) // 3, 2000)
                                _r = await _pipe.process(
                                    content=instruction,
                                    max_tokens=_target // 4,
                                    query="Compress instruction preserving task, tools, constraints",
                                    goal="Keep task description, tool list, output format, critical constraints. Drop examples and verbose guidance.",
                                    context_type="context",
                                )
                                instruction = _r.content
                                logger.info(f"Instruction compressed to {len(instruction)} chars, retrying")
                                attempt += 1
                                continue
                            except Exception as _ic_err:
                                logger.warning(f"Instruction compression failed: {_ic_err}")
                        raise RuntimeError(
                            f"CONTEXT_TOO_LARGE: Instruction payload ({len(instruction or '')} chars) "
                            f"exceeds model context window after system prompt "
                            f"{'and instruction ' if self._system_prompt_compressed else ''}"
                            f"compression. The task needs decomposition or upstream "
                            f"context reduction. context_length_exceeded"
                        ) from e

                    if attempt >= self._max_compression_retries:
                        logger.error(f"Max retries ({self._max_compression_retries}) reached - context still too long")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I have reached max retries ({self._max_compression_retries}) - context still too long"}
                        logger.error(f"   Original history: {len(conversation_history)} chars")
                        logger.error(f"   Compressed history: {len(current_history)} chars")
                        logger.error(f"   Trajectory: {len(trajectory)} chars")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"Original history: {len(conversation_history)} chars, Compressed: {len(current_history)} chars, Trajectory: {len(trajectory)} chars"}
                        raise RuntimeError(
                            f"CONTEXT_TOO_LARGE: Failed to compress context within "
                            f"{self._max_compression_retries} attempts. "
                            f"Original: {len(conversation_history)} chars, "
                            f"Final: {len(current_history)} chars, "
                            f"Trajectory: {len(trajectory)} chars. "
                            f"context_length_exceeded — task needs decomposition "
                            f"or upstream context reduction."
                        ) from e
                    
                    # Extract current ReAct trajectory from the generate module's state
                    # This preserves the steps taken so far in THIS iteration
                    try:
                        if hasattr(self.generate, '_store') and isinstance(self.generate._store, dict):
                            store = self.generate._store
                            trajectory_parts = []
                            
                            # Build trajectory from ReAct steps
                            if 'trajectory' in store:
                                trajectory = store['trajectory']
                                logger.info(f"📋 Extracted trajectory from _store: {len(trajectory)} chars")
                                yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I extracted trajectory from _store: {len(trajectory)} chars"}
                            else:
                                # Build from individual step components
                                for key in ['thought', 'next_thought', 'action', 'next_tool_name', 'observation']:
                                    if key in store and store[key]:
                                        trajectory_parts.append(f"{key}: {store[key]}")
                                
                                if trajectory_parts:
                                    new_trajectory = "\n".join(trajectory_parts)
                                    trajectory = trajectory + "\n" + new_trajectory if trajectory else new_trajectory
                                    logger.info(f"📋 Built trajectory from steps: {len(trajectory)} chars")
                                    yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I built trajectory from steps: {len(trajectory)} chars"}
                    except Exception as traj_error:
                        logger.warning(f"⚠️  Could not extract trajectory: {traj_error}")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": f"I encountered a warning while extracting trajectory: {str(traj_error)}"}
                        # Continue anyway - trajectory will be empty but we'll still compress
                    
                    # Context too long — decide WHAT to compress based on where
                    # the bulk of the tokens actually lives.
                    logger.warning(f"⚠️  Context length error during ReAct execution")
                    yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "I encountered a context length error during ReAct execution"}

                    from core.components.context_compressor.token_utils import count_tokens
                    from core.components.context_compressor.content_ingestion import (
                        ContentIngestionPipeline,
                    )

                    history_chars = len(conversation_history or "")
                    instruction_chars = len(instruction or "")
                    trajectory_chars = len(trajectory or "")

                    sizes = {
                        "history": history_chars,
                        "instruction": instruction_chars,
                        "trajectory": trajectory_chars,
                    }
                    bloat_source = max(sizes, key=sizes.get)

                    logger.info(
                        f"🗜️ Context overflow — sizes: history={history_chars}, "
                        f"instruction={instruction_chars}, trajectory={trajectory_chars} "
                        f"— bloat source: {bloat_source}"
                    )
                    logger.info(
                        "context_length_compression_retry agent=%s attempt=%s bloat_source=%s "
                        "history_chars=%s instruction_chars=%s trajectory_chars=%s",
                        self.AGENT_NAME, attempt, bloat_source,
                        history_chars, instruction_chars, trajectory_chars,
                    )
                    yield {
                        "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}",
                        "message": (
                            f"Context overflow — bloat source: {bloat_source} "
                            f"(history={history_chars}, instruction={instruction_chars}, "
                            f"trajectory={trajectory_chars})"
                        ),
                    }

                    tool_tokens = self._measure_tool_tokens()

                    if bloat_source == "trajectory" and trajectory_chars > 5000:
                        target_traj_chars = max(
                            (self._PREEMPTIVE_MODEL_LIMIT - tool_tokens - 5000
                             - count_tokens(instruction) - count_tokens(current_history)
                             - 15000) * 4,
                            20000,
                        )
                        logger.info(f"🗜️ Compressing trajectory: {trajectory_chars} → target {target_traj_chars} chars")
                        try:
                            pipeline = ContentIngestionPipeline()
                            result = await pipeline.process(
                                content=trajectory,
                                max_tokens=target_traj_chars // 4,
                                query="Compress agent trajectory preserving last 3 actions and all results",
                                goal=(
                                    "Keep the most recent tool calls, observations, "
                                    "and reasoning. Drop older intermediate steps. "
                                    "Preserve any file paths, URLs, error messages, and final outputs."
                                ),
                                context_type="context",
                            )
                            trajectory = result.content
                            logger.info(f"✅ Trajectory compressed: {trajectory_chars} → {len(trajectory)} chars")
                        except Exception as _comp_err:
                            logger.warning(f"⚠️  Trajectory compression failed: {_comp_err}")
                            try:
                                from core.components.context_compressor.unified_compression import (
                                    UnifiedCompressor,
                                )
                                uc = UnifiedCompressor()
                                trajectory = await uc.compress(
                                    trajectory,
                                    max_tokens=target_traj_chars // 4,
                                    goal=(
                                        "Preserve recent tool calls, observations, file paths, "
                                        "URLs, error messages, and all final outputs."
                                    ),
                                )
                            except Exception as _uc_err:
                                logger.warning(f"⚠️  UnifiedCompressor trajectory fallback failed: {_uc_err}; using full trajectory")

                    elif bloat_source == "instruction" and instruction_chars > 10000:
                        target = max(
                            self._PREEMPTIVE_MODEL_LIMIT
                            - tool_tokens
                            - 5000
                            - count_tokens(trajectory)
                            - count_tokens(current_history)
                            - 15000,
                            10000,
                        )
                        logger.info(f"🗜️ Compressing instruction: {instruction_chars} chars → target {target} tokens")
                        try:
                            pipeline = ContentIngestionPipeline()
                            result = await pipeline.process(
                                content=instruction,
                                max_tokens=target,
                                query="Compress task instruction to fit model context",
                                goal=(
                                    "Preserve task description, goal, dependency "
                                    "context, file paths, and all critical details. "
                                    "COMPRESSION not summarization."
                                ),
                                context_type="context",
                            )
                            instruction = result.content
                            logger.info(f"✅ Instruction compressed: {instruction_chars} → {len(instruction)} chars")
                        except Exception as _comp_err:
                            logger.warning(f"⚠️  Instruction compression failed: {_comp_err}")

                    else:
                        logger.info(f"🗜️ Compressing conversation history (ratio: {compression_ratio:.2f})")
                        yield {"module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}", "message": "Compressing conversation history"}
                        compressed_old_history = await self._compress_conversation_history(
                            conversation_history=conversation_history,
                            instruction=instruction,
                            compression_ratio=compression_ratio
                        )
                        current_history = compressed_old_history

                    if not self._system_prompt_compressed:
                        _sp_ok = await self._compress_system_prompt()
                        if _sp_ok:
                            logger.info("System prompt also compressed to free additional headroom")

                    compression_ratio *= _compression_ratio_env

                    total_after = len(current_history) + len(trajectory) + len(instruction)
                    logger.info(f"   Post-compression total: {total_after} chars")
                    yield {
                        "module": f"vinv_engine.agents.{self.AGENT_NAME.lower()}",
                        "message": f"Post-compression total: {total_after} chars — retrying",
                    }

            # All retry iterations exhausted without returning or raising.
            # This is structurally unreachable since the last iteration's
            # except block raises at `attempt >= self._max_compression_retries`,
            # but we guard against it explicitly.
            raise RuntimeError(
                f"CONTEXT_TOO_LARGE: exhausted {self._max_compression_retries} "
                f"compression retries without convergence. "
                f"history={len(current_history)} trajectory={len(trajectory)} "
                f"instruction={len(instruction)} — task needs decomposition."
            )

        async def astream(
            self,
            instruction: str,
            conversation_history: str = "",
            session_id: Optional[str] = None,
            model_id: Optional[str] = None,
            context: Optional[Any] = None,
            **kwargs
        ):
            """Async stream that yields intermediary steps."""
            log_agent_model_usage(self.AGENT_NAME, "astream")

            if context:
                session_id = context.session_id or session_id
                conversation_history = context.conversation_history or conversation_history
                model_id = context.model_id or model_id

            self.model_id = model_id
            
            # Let subclasses prepare any tool-specific state
            _prep_result = self._prepare_for_execution(**kwargs)
            if inspect.isawaitable(_prep_result):
                execution_context = await _prep_result
            else:
                execution_context = _prep_result

            yield {"event": "log", "data": {"agent": self.AGENT_NAME, "data": f"🚀 {self.AGENT_NAME} starting task execution..."}}

            queue: asyncio.Queue[dict] = asyncio.Queue()
            react_callback = self._ReActStreamCallback(queue, self.AGENT_NAME)

            # 🔧 FIX: Preserve DSPy ReAct's built-in 'finish' tool when updating tools
            new_tools = self._create_bound_tools()
            if hasattr(self.generate, 'tools') and 'finish' in self.generate.tools:
                original_finish = self.generate.tools['finish']
                # Wrap finish tool to filter out invalid arguments (finish only accepts final_answer)
                def wrapped_finish(*args, **kwargs):
                    # Filter kwargs to only include final_answer (the only valid argument for finish)
                    filtered_kwargs = {k: v for k, v in kwargs.items() if k == 'final_answer'}
                    # If final_answer not in kwargs, try to extract from args or use first arg
                    if 'final_answer' not in filtered_kwargs and args:
                        filtered_kwargs['final_answer'] = args[0] if args else ''
                    # Call original finish with only valid arguments
                    return original_finish(**filtered_kwargs)
                wrapped_finish.__name__ = 'finish'
                wrapped_finish.__doc__ = getattr(original_finish, '__doc__', 'Finish the task with final answer')
                new_tools['finish'] = wrapped_finish
            # Merge any tools injected via _vinv_engine_additional_tools
            logger_local = logging.getLogger(f"vinv_engine.agents.{self.AGENT_NAME}")
            if hasattr(self, '_vinv_engine_additional_tools') and self._vinv_engine_additional_tools:
                tools_before = len(new_tools)
                for tool in self._vinv_engine_additional_tools:
                    tool_name = getattr(tool, 'name', None) or getattr(tool, '__name__', None) or str(tool)
                    if tool_name not in new_tools:
                        new_tools[tool_name] = tool
                tools_after = len(new_tools)
                logger_local.debug(f"🔍 [TOOL MERGE DEBUG] _create_bound_tools merged {len(self._vinv_engine_additional_tools)} tools | before={tools_before} | after={tools_after}")
            self.generate.tools = new_tools

            generate_kwargs = {
                "instruction": instruction,
                "conversation_history": conversation_history or "",
                **execution_context  # Include any tool-specific state
            }

            try:
                _astream_max_retries = int(os.environ.get("VINV_ENGINE_ASTREAM_MAX_RETRIES", "6"))
                last_error = None
                result = None
                for attempt in range(_astream_max_retries):
                    try:
                        with dspy.context(callbacks=[react_callback]):
                            result = await self.generate.acall(**generate_kwargs)
                        break
                    except Exception as e:
                        last_error = e
                        if is_timeout_error(e) and attempt < _astream_max_retries - 1:
                            delay = min(1.0 * (2 ** attempt), 60.0)
                            await queue.put({"event": "log", "data": {"agent": self.AGENT_NAME, "data": f"⚠️ Timeout (attempt {attempt + 1}/{_astream_max_retries}), retrying in {delay:.2f}s..."}})
                            await asyncio.sleep(delay)
                            continue
                        raise
                if result is None and last_error:
                    raise last_error

                # Drain remaining callback events
                while not queue.empty():
                    try:
                        message = queue.get_nowait()
                        if message:
                            yield message
                    except asyncio.QueueEmpty:
                        break
            except Exception as e:
                error_type = type(e).__name__
                error_message = str(e)

                if "timeout" in error_message.lower():
                    yield {"event": "error", "data": {"agent": self.AGENT_NAME, "data": "❌ Error: Request timed out."}}
                    return
                if "parse" in error_message.lower():
                    yield {"event": "error", "data": {"agent": self.AGENT_NAME, "data": "❌ Error: Failed to parse response."}}
                    return

                yield {"event": "error", "data": {"agent": self.AGENT_NAME, "data": f"❌ Error: {error_type}: {error_message}"}}
                return

            analysis = getattr(result, 'analysis', '')
            plan = getattr(result, 'plan', '')
            commands = getattr(result, 'commands', '')
            task_complete = getattr(result, 'task_complete', False)
            reasoning = getattr(result, 'reasoning', '')

            await self._review_completion_state(
                instruction=instruction,
                result=result,
                execution_context=execution_context if isinstance(execution_context, dict) else {}
            )
            completion_state = getattr(result, "_store", {}).get("completion_state", "unknown") if result is not None else "unknown"
            unresolved_items = getattr(result, "_store", {}).get("unresolved_items", []) if result is not None else []

            yield {
                "event": "log",
                "data": {
                    "agent": self.AGENT_NAME,
                    "data": (
                        f"✅ Task Result\n\n"
                        f"Analysis: {analysis}\n"
                        f"Plan: {plan}\n"
                        f"Task Complete: {task_complete}\n"
                        f"Completion State: {completion_state}\n"
                        f"Unresolved Items: {json.dumps(unresolved_items, default=str)}\n"
                        f"Reasoning: {reasoning}"
                    )
                }
            }
            yield {"event": "result", "data": {"agent": self.AGENT_NAME, "data": result, "input": {"instruction": instruction}}}

else:
    class BaseSwarmAgent:
        """Placeholder when dspy is not available."""
        def __init__(self, max_iters: Optional[int] = None, tools: list = None):
            raise RuntimeError(
                "BaseSwarmAgent requires dspy to be installed. "
                "Install it with: pip install dspy-ai"
            )
