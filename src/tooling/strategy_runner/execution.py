"""VectorBT execution engine for long-only target-weight strategy packages.

Strategy code emits sparse target-weight snapshots. This module owns execution
semantics so that package code does not need to depend on VectorBT or reproduce
fees, order sequencing, and risk controls.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import vectorbt as vbt
from numba import njit
from vectorbt.portfolio import nb
from vectorbt.portfolio.enums import (
    CallSeqType,
    Direction,
    NoOrder,
    OrderSide,
    OrderStatus,
    SizeType,
)

__all__ = ["simulate_target_weight_portfolio"]


@njit(cache=True)
def _pre_sim_func_nb(c):
    column_count = c.target_shape[1]
    order_value_out = np.empty(column_count, dtype=np.float64)
    reference_price = np.full(column_count, np.nan, dtype=np.float64)
    reentry_blocked = np.zeros(column_count, dtype=np.bool_)
    stop_trigger_index = np.full(column_count, -1, dtype=np.int64)
    pending_exit_index = np.full(column_count, -1, dtype=np.int64)
    is_stop_order = np.zeros(column_count, dtype=np.bool_)
    desired_weights = np.full(c.target_shape, np.nan, dtype=np.float64)
    return (
        order_value_out,
        reference_price,
        reentry_blocked,
        stop_trigger_index,
        pending_exit_index,
        is_stop_order,
        desired_weights,
    )


@njit(cache=True)
def _pre_segment_func_nb(
    c,
    order_value_out,
    reference_price,
    reentry_blocked,
    stop_trigger_index,
    pending_exit_index,
    is_stop_order,
    desired_weights,
    raw_target_weights,
    initial_target_weights,
    delay_bars,
):
    for column in range(c.from_col, c.to_col):
        close_now = nb.get_col_elem_nb(c, column, c.close)
        c.last_val_price[column] = close_now
        desired_weights[c.i, column] = np.nan
        is_stop_order[column] = False

        if c.i == 0 and np.isfinite(initial_target_weights[column]):
            # This target was determined strictly before the evaluation range,
            # so it can be filled causally at the first evaluation close.
            desired_weights[c.i, column] = initial_target_weights[column]
        source_index = c.i - delay_bars
        if source_index >= 0:
            target_now = raw_target_weights[source_index, column]
            if np.isfinite(target_now):
                # A target from the trigger bar itself is not a new re-entry
                # instruction. Only a later explicit snapshot releases the lock.
                if (
                    reentry_blocked[column]
                    and source_index > stop_trigger_index[column]
                ):
                    reentry_blocked[column] = False
                    stop_trigger_index[column] = -1
                if not reentry_blocked[column]:
                    desired_weights[c.i, column] = target_now

        # A due risk exit wins over a target scheduled for the same fill bar.
        if pending_exit_index[column] == c.i:
            desired_weights[c.i, column] = 0.0
            is_stop_order[column] = True
            pending_exit_index[column] = -1

    # Portfolio.from_order_func does not apply CallSeqType.Auto itself. Sort the
    # shared-cash group by estimated order value so sells release funds first.
    nb.sort_call_seq_nb(
        c,
        desired_weights,
        SizeType.TargetPercent,
        Direction.LongOnly,
        order_value_out[c.from_col : c.to_col],
    )
    return (
        order_value_out,
        reference_price,
        reentry_blocked,
        stop_trigger_index,
        pending_exit_index,
        is_stop_order,
        desired_weights,
    )


@njit(cache=True)
def _order_func_nb(
    c,
    order_value_out,
    reference_price,
    reentry_blocked,
    stop_trigger_index,
    pending_exit_index,
    is_stop_order,
    desired_weights,
    proportional_fee_rate,
    fixed_fee_per_order,
    slippage_rate,
    minimum_order_shares,
    share_increment,
):
    target_now = desired_weights[c.i, c.col]
    price_now = nb.get_elem_nb(c, c.close)
    if not np.isfinite(target_now) or not np.isfinite(price_now):
        return NoOrder
    return nb.order_nb(
        size=target_now,
        size_type=SizeType.TargetPercent,
        direction=Direction.LongOnly,
        price=price_now,
        fees=proportional_fee_rate,
        fixed_fees=fixed_fee_per_order,
        slippage=slippage_rate,
        min_size=minimum_order_shares,
        size_granularity=share_increment,
        allow_partial=True,
    )


@njit(cache=True)
def _post_order_func_nb(
    c,
    order_value_out,
    reference_price,
    reentry_blocked,
    stop_trigger_index,
    pending_exit_index,
    is_stop_order,
    desired_weights,
):
    result = c.order_result
    if result.status == OrderStatus.Filled:
        if result.side == OrderSide.Buy:
            # OrderResult.price already includes slippage. Fees are intentionally
            # excluded from the configured weighted-average-fill reference.
            if (
                c.position_before <= 0.0
                or not np.isfinite(reference_price[c.col])
            ):
                reference_price[c.col] = result.price
            else:
                reference_price[c.col] = (
                    c.position_before * reference_price[c.col]
                    + result.size * result.price
                ) / c.position_now
        elif c.position_now <= 0.0:
            reference_price[c.col] = np.nan
            pending_exit_index[c.col] = -1
    elif is_stop_order[c.col] and c.position_now > 0.0:
        # An invalid/missing fill must not silently cancel a risk exit.
        if c.i + 1 < c.target_shape[0]:
            pending_exit_index[c.col] = c.i + 1


@njit(cache=True)
def _post_segment_func_nb(
    c,
    order_value_out,
    reference_price,
    reentry_blocked,
    stop_trigger_index,
    pending_exit_index,
    is_stop_order,
    desired_weights,
    stop_loss_rate,
    take_profit_rate,
):
    for column in range(c.from_col, c.to_col):
        close_now = nb.get_col_elem_nb(c, column, c.close)
        stop_loss_hit = (
            np.isfinite(stop_loss_rate)
            and close_now
            <= reference_price[column] * (1.0 - stop_loss_rate)
        )
        take_profit_hit = (
            np.isfinite(take_profit_rate)
            and close_now
            >= reference_price[column] * (1.0 + take_profit_rate)
        )
        if (
            not reentry_blocked[column]
            and c.last_position[column] > 0.0
            and np.isfinite(reference_price[column])
            and (stop_loss_hit or take_profit_hit)
        ):
            # Orders scheduled for this close have already filled and updated the
            # weighted-average reference. Observe that completed close state and
            # queue the configured risk exit for the following bar's close.
            reentry_blocked[column] = True
            stop_trigger_index[column] = c.i
            if c.i + 1 < c.target_shape[0]:
                pending_exit_index[column] = c.i + 1


def _finite_number(name: str, value: float, *, minimum: float = 0.0) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < minimum:
        raise ValueError(f"{name} must be a finite number >= {minimum}")
    return parsed


def _optional_positive_rate(name: str, value: float | None) -> float:
    if value is None:
        return math.nan
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0.0:
        raise ValueError(f"{name} must be null or a finite number > 0")
    return parsed


def _validated_inputs(
    close: pd.DataFrame,
    raw_target_weights: pd.DataFrame,
) -> tuple[pd.DataFrame, np.ndarray]:
    if not isinstance(close, pd.DataFrame):
        raise TypeError("close must be a pandas DataFrame")
    if not isinstance(raw_target_weights, pd.DataFrame):
        raise TypeError("raw_target_weights must be a pandas DataFrame")
    if close.empty or close.shape[1] == 0:
        raise ValueError("close must contain at least one row and one symbol")
    if not isinstance(close.index, pd.DatetimeIndex):
        raise TypeError("close must use a DatetimeIndex")
    if not close.index.is_monotonic_increasing or not close.index.is_unique:
        raise ValueError("close index must be sorted and unique")
    if not close.columns.is_unique:
        raise ValueError("close symbol columns must be unique")
    if not raw_target_weights.index.equals(close.index):
        raise ValueError("raw_target_weights index must exactly match close")
    if not raw_target_weights.columns.equals(close.columns):
        raise ValueError("raw_target_weights columns must exactly match close")

    try:
        close_values = close.to_numpy(dtype=np.float64, copy=True)
        target_values = raw_target_weights.to_numpy(dtype=np.float64, copy=True)
    except (TypeError, ValueError) as error:
        raise TypeError("close and raw_target_weights must be numeric") from error
    if not np.isfinite(close_values).all() or np.any(close_values <= 0.0):
        raise ValueError("close must contain only finite positive prices")
    if np.isinf(target_values).any():
        raise ValueError("raw_target_weights must contain only finite values or NaN")

    finite_targets = np.isfinite(target_values)
    finite_per_row = finite_targets.sum(axis=1)
    if np.any((finite_per_row != 0) & (finite_per_row != close.shape[1])):
        raise ValueError("each target row must be either fully explicit or fully NaN")
    if np.any(target_values[finite_targets] < 0.0) or np.any(
        target_values[finite_targets] > 1.0
    ):
        raise ValueError("target weights must be between 0 and 1")
    explicit_rows = finite_per_row == close.shape[1]
    if np.any(target_values[explicit_rows].sum(axis=1) > 1.0 + 1e-12):
        raise ValueError("target weights must not exceed 100% gross exposure")

    return (
        pd.DataFrame(close_values, index=close.index, columns=close.columns),
        target_values,
    )


def _validated_initial_target(
    initial_target_weights: pd.Series | None,
    columns: pd.Index,
) -> np.ndarray:
    if initial_target_weights is None:
        return np.full(len(columns), np.nan, dtype=np.float64)
    if not isinstance(initial_target_weights, pd.Series):
        raise TypeError("initial_target_weights must be a pandas Series or None")
    if not initial_target_weights.index.equals(columns):
        raise ValueError("initial_target_weights index must exactly match close columns")
    try:
        values = initial_target_weights.to_numpy(dtype=np.float64, copy=True)
    except (TypeError, ValueError) as error:
        raise TypeError("initial_target_weights must be numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("initial_target_weights must contain only finite values")
    if np.any(values < 0.0) or np.any(values > 1.0):
        raise ValueError("initial_target_weights must be between 0 and 1")
    if values.sum() > 1.0 + 1e-12:
        raise ValueError("initial_target_weights must not exceed 100% gross exposure")
    return values


def simulate_target_weight_portfolio(
    close: pd.DataFrame,
    raw_target_weights: pd.DataFrame,
    *,
    initial_cash: float,
    delay_bars: int,
    proportional_fee_rate: float,
    fixed_fee_per_order: float,
    slippage_rate: float,
    minimum_order_shares: float,
    share_increment: float,
    stop_loss_rate: float | None,
    take_profit_rate: float | None,
    initial_target_weights: pd.Series | None = None,
    frequency: str | None = None,
) -> vbt.Portfolio:
    """Simulate sparse long-only target weights as one shared-cash portfolio.

    Targets are executed after ``delay_bars`` at that bar's close. Rebalances
    sell before buying. Stops are evaluated against the raw close and the
    slippage-adjusted weighted-average fill, execute at the next bar's close,
    and suppress re-entry until a target snapshot emitted strictly after the
    trigger. Returned VectorBT order records are the transaction ledger source.

    ``initial_target_weights`` is an optional target determined before this
    panel and fills at its first close; row-zero raw targets still observe the
    configured delay. ``None`` disables the corresponding stop. This function
    intentionally accepts already-resolved scalar settings; parsing package JSON
    and loading market data belong to the runner boundary.
    """

    normalized_close, target_values = _validated_inputs(close, raw_target_weights)
    initial_target_values = _validated_initial_target(
        initial_target_weights,
        normalized_close.columns,
    )
    if isinstance(delay_bars, bool) or not isinstance(delay_bars, (int, np.integer)):
        raise TypeError("delay_bars must be a non-negative integer")
    if delay_bars < 1:
        raise ValueError("delay_bars must be at least 1 for close-derived targets")

    resolved_initial_cash = _finite_number("initial_cash", initial_cash, minimum=0.0)
    if resolved_initial_cash == 0.0:
        raise ValueError("initial_cash must be greater than 0")
    resolved_fee_rate = _finite_number(
        "proportional_fee_rate", proportional_fee_rate
    )
    if resolved_fee_rate >= 1.0:
        raise ValueError("proportional_fee_rate must be less than 1")
    resolved_fixed_fee = _finite_number("fixed_fee_per_order", fixed_fee_per_order)
    resolved_slippage = _finite_number("slippage_rate", slippage_rate)
    if resolved_slippage >= 1.0:
        raise ValueError("slippage_rate must be less than 1")
    resolved_minimum_order = _finite_number(
        "minimum_order_shares", minimum_order_shares
    )
    if resolved_minimum_order == 0.0:
        raise ValueError("minimum_order_shares must be greater than 0")
    resolved_increment = _finite_number("share_increment", share_increment)
    if resolved_increment == 0.0:
        raise ValueError("share_increment must be greater than 0")
    resolved_stop_loss = _optional_positive_rate("stop_loss_rate", stop_loss_rate)
    if np.isfinite(resolved_stop_loss) and resolved_stop_loss >= 1.0:
        raise ValueError("stop_loss_rate must be less than 1")
    resolved_take_profit = _optional_positive_rate(
        "take_profit_rate", take_profit_rate
    )

    return vbt.Portfolio.from_order_func(
        normalized_close,
        _order_func_nb,
        resolved_fee_rate,
        resolved_fixed_fee,
        resolved_slippage,
        resolved_minimum_order,
        resolved_increment,
        init_cash=resolved_initial_cash,
        cash_sharing=True,
        group_by=True,
        call_seq=CallSeqType.Default,
        pre_sim_func_nb=_pre_sim_func_nb,
        pre_segment_func_nb=_pre_segment_func_nb,
        pre_segment_args=(
            target_values,
            initial_target_values,
            int(delay_bars),
        ),
        post_order_func_nb=_post_order_func_nb,
        post_segment_func_nb=_post_segment_func_nb,
        post_segment_args=(
            resolved_stop_loss,
            resolved_take_profit,
        ),
        update_value=True,
        freq=frequency,
    )
