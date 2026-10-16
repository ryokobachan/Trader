"""Numerical and boundary tests for Trader's actual TA-Lib calculation bridge."""

import copy
import importlib.util
import json
import math
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import talib
from talib import abstract

SPEC = importlib.util.spec_from_file_location(
    "trader_talib_test", Path(__file__).resolve().parents[1] / "api" / "tradingview-websocket" / "talib_indicators.py"
)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def bars(count=180):
    rows = []
    for index in range(count):
        opening = 100 + index * 0.1 + math.sin(index * 0.5) * 7
        closing = opening + math.sin(index * 0.7) * 2
        rows.append({"time": (date(2024, 1, 1) + timedelta(days=index)).isoformat(), "open": opening, "close": closing,
                     "high": max(opening, closing) + 1.2, "low": min(opening, closing) - 0.8,
                     "volume": 1000 + index % 7 * 120})
    return rows


def calculate(indicators, observations=None):
    return helper.calculate({"bars": observations if observations is not None else bars(), "indicators": indicators})


class TalibIndicatorsTests(unittest.TestCase):
    def test_catalog_has_129_real_functions_and_61_candlestick_patterns(self):
        result = helper.catalog()
        self.assertEqual(result["schemaVersion"], "trader.talib.v1")
        self.assertEqual(result["engine"], "TA-Lib")
        self.assertEqual(result["version"], talib.__version__)
        self.assertEqual(result["limits"], {"maxBars": 10000, "maxIndicators": 8, "maxPeriod": 10000})
        self.assertEqual(len(result["indicators"]), 129)
        self.assertEqual(sum(row["group"] == "Pattern Recognition" for row in result["indicators"]), 61)
        self.assertFalse({"MAVP", "BETA", "CORREL", "ADD", "SIN"} & {row["id"] for row in result["indicators"]})
        for row in result["indicators"]:
            function = abstract.Function(row["id"])
            self.assertEqual(row["parameters"], dict(function.parameters))
            self.assertEqual(row["inputs"], dict(function.input_names))
            self.assertEqual(row["outputs"], function.output_names)
            self.assertEqual(row["lookback"], function.lookback)
        json.dumps(result, allow_nan=False)

    def test_each_function_matches_native_talib_outputs_and_lookback(self):
        observations = bars()
        columns = {column: np.array([row[column] for row in observations], dtype=np.float64) for column in helper.PRICE_COLUMNS}
        identifiers = list(helper.FUNCTION_IDS)
        for offset in range(0, len(identifiers), 8):
            response = calculate([{"id": name} for name in identifiers[offset:offset + 8]], observations)
            self.assertEqual(response["times"], [row["time"] for row in observations])
            self.assertEqual(response["barCount"], len(observations))
            for row in response["results"]:
                with self.subTest(indicator=row["id"]):
                    function = abstract.Function(row["id"])
                    native = function(columns)
                    outputs = [native] if len(function.output_names) == 1 else list(native)
                    self.assertEqual(len(row["series"]), len(outputs))
                    for series, values in zip(row["series"], outputs):
                        expected = [None if i < function.lookback or not math.isfinite(float(value)) else value for i, value in enumerate(values)]
                        self.assertEqual(series["values"], expected)
            json.dumps(response, allow_nan=False)

    def test_future_bars_never_change_prefix_results_for_any_function(self):
        observations = bars()
        identifiers = list(helper.FUNCTION_IDS)
        for offset in range(0, len(identifiers), 8):
            specifications = [{"id": name} for name in identifiers[offset:offset + 8]]
            prefix = calculate(specifications, observations[:100])
            full = calculate(specifications, observations)
            for short, long in zip(prefix["results"], full["results"]):
                with self.subTest(indicator=short["id"]):
                    for a, b in zip(short["series"], long["series"]):
                        self.assertEqual(a["values"], b["values"][:100])

    def test_parameters_and_custom_price_input_are_applied_and_isolated(self):
        observations = bars(50)
        response = calculate([{"id": "SMA", "parameters": {"timeperiod": 5}, "inputs": {"price": "open"}},
                              {"id": "BBANDS", "parameters": {"nbdevup": 3, "matype": 1}}], observations)
        sma = response["results"][0]
        self.assertEqual(sma["parameters"], {"timeperiod": 5})
        self.assertEqual(sma["inputs"], {"price": "open"})
        self.assertEqual(sma["lookback"], 4)
        self.assertAlmostEqual(sma["series"][0]["values"][4], sum(row["open"] for row in observations[:5]) / 5)
        ordinary = calculate([{"id": "SMA"}], observations)["results"][0]
        self.assertEqual(ordinary["parameters"], {"timeperiod": 30})
        self.assertEqual(ordinary["inputs"], {"price": "close"})
        self.assertEqual(ordinary["lookback"], 29)
        # Multi-price inputs keep their arity and exact effective mapping.
        renamed = calculate([{"id": "STOCH", "inputs": {"prices": ["high", "low", "open"]}}], observations)["results"][0]
        self.assertEqual(renamed["inputs"], {"prices": ["high", "low", "open"]})
        function = abstract.Function("STOCH")
        function.set_input_names({"prices": ["high", "low", "open"]})
        columns = {column: np.array([bar[column] for bar in observations], dtype=np.float64) for column in helper.PRICE_COLUMNS}
        for series, expected in zip(renamed["series"], function(columns)):
            self.assertEqual(series["values"][function.lookback:], list(expected[function.lookback:]))

    def test_candlestick_warmup_is_null_not_no_pattern_signal(self):
        row = calculate([{"id": "CDLDOJI"}])["results"][0]
        values = row["series"][0]["values"]
        self.assertEqual(values[:row["lookback"]], [None] * row["lookback"])
        self.assertTrue(all(type(value) is int for value in values[row["lookback"]:]))
        self.assertTrue(any(value == 100 for value in values[row["lookback"]:]))
        short = calculate([{"id": "CDLDOJI"}, {"id": "MACD"}], bars(2))
        self.assertTrue(all(series["values"] == [None, None] for row in short["results"] for series in row["series"]))

    def test_structural_and_indicator_bounds_reject_unknown_data(self):
        valid = {"bars": bars(2), "indicators": [{"id": "SMA"}]}
        invalid = [None, [], {}, {**valid, "url": "https://example.com"}, {**valid, "indicators": []},
                   {**valid, "indicators": [{"id": "SMA"}] * 9},
                   {**valid, "indicators": [{"id": "SMA"}, {"id": "SMA", "parameters": {"timeperiod": 5}}]},
                   {**valid, "bars": []}, {**valid, "bars": bars(10001)}]
        for spec in [None, [], {}, {"id": "sma"}, {"id": "MAVP"}, {"id": "BETA"}, {"id": "CORREL"},
                     {"id": "ADD"}, {"id": "__import__('os')"}, {"id": "SMA", "code": "bad"}, {"id": ["SMA"]}]:
            invalid.append({**valid, "indicators": [spec]})
        for payload in invalid:
            with self.subTest(payload_type=type(payload).__name__):
                with self.assertRaises(ValueError):
                    helper.calculate(payload)

    def test_parameter_types_ranges_and_native_invalid_ranges_are_rejected(self):
        invalid = [{"unknown": 1}]
        invalid += [{"timeperiod": value} for value in [True, None, "10", 0, -1, 1, 1.5, 10001, float("nan"), float("inf"), 10 ** 1000]]
        for parameters in [None, [], *invalid]:
            with self.subTest(parameters=str(parameters)[:70]), self.assertRaises(ValueError):
                calculate([{"id": "SMA", "parameters": parameters}])
        for spec in [{"id": "MA", "parameters": {"matype": 9}}, {"id": "MA", "parameters": {"matype": -1}},
                     {"id": "BBANDS", "parameters": {"nbdevup": -1}}, {"id": "BBANDS", "parameters": {"nbdevup": 1000001}},
                     {"id": "T3", "parameters": {"vfactor": 2}}, {"id": "MAMA", "parameters": {"fastlimit": 0}},
                     {"id": "CDLMATHOLD", "parameters": {"penetration": float("inf")}}]:
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                calculate([spec])

    def test_input_names_and_arities_are_validated(self):
        invalid = [None, [], {"price": "file:///tmp/a"}, {"price": "adjclose"}, {"price": ["close"]}, {"prices": "close"}, {"price": True}]
        for inputs in invalid:
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                calculate([{"id": "SMA", "inputs": inputs}])
        for inputs in [{"prices": "close"}, {"prices": ["high", "low"]}, {"prices": ["high", "low", None]}]:
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                calculate([{"id": "STOCH", "inputs": inputs}])

    def test_bad_bars_never_get_silently_dropped_filled_or_sorted(self):
        base = bars(3)
        invalid = []
        for field, value in [("time", True), ("time", float("nan")), ("time", -1), ("time", 1.5), ("time", 2**53),
                             ("open", None), ("close", float("inf")), ("volume", -1), ("low", -1),
                             ("volume", True), ("high", 1), ("open", 10000), ("close", 10**1000)]:
            rows = copy.deepcopy(base)
            rows[1][field] = value
            invalid.append(rows)
        invalid.extend([list(reversed(base)), [base[0], base[0]], [None], [{**base[0], "adjusted": True}], [{k: v for k, v in base[0].items() if k != "volume"}]])
        for rows in invalid:
            with self.subTest(rows_type=type(rows).__name__), self.assertRaises(ValueError):
                calculate([{"id": "RSI"}], rows)

    def test_canonical_date_and_zoned_timestamp_labels_are_preserved_exactly(self):
        labels = ["2026-03-06", "2026-03-06T00:00:00.000000001Z", "2026-03-06T00:00:00.000000002+00:00",
                  "2026-03-06T16:00:00-05:00", "2026-03-09T09:30:00-04:00", "2026-03-09T13:31:00Z"]
        observations = [{**bar, "time": label} for bar, label in zip(bars(len(labels)), labels)]
        response = calculate([{"id": "SMA", "parameters": {"timeperiod": 2}}], observations)
        self.assertEqual(response["times"], labels)
        self.assertEqual(response["barCount"], len(labels))
        # Absolute ordering is independent of the source's timezone labels.
        observations = [{**bar, "time": label} for bar, label in zip(bars(2), ["2026-01-01T23:00:00-05:00", "2026-01-02T03:30:00-01:00"])]
        self.assertEqual(calculate([{"id": "OBV"}], observations)["times"], [row["time"] for row in observations])

    def test_bad_calendar_labels_naive_times_and_duplicate_absolute_instants_are_rejected(self):
        invalid = ["2026-02-30", "2026-02-29", "2026-13-01", "0000-01-01", "2026-1-01", "20260101",
                   "2026-01-01T12:00:00", "2026-01-01 12:00:00Z", "2026-01-01T24:00:00Z",
                   "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00", "2026-01-01T12:00:00Z ",
                   "2026-01-01T12:00:00.1234567890Z", 1700000000, True, None, {}]
        for label in invalid:
            with self.subTest(label=label), self.assertRaises(ValueError):
                calculate([{"id": "OBV"}], [{**bars(1)[0], "time": label}])
        for labels in [["2026-01-01", "2026-01-01T00:00:00Z"],
                       ["2026-01-01T09:30:00-05:00", "2026-01-01T14:30:00Z"],
                       ["2026-01-01T23:00:00-05:00", "2026-01-02T03:30:00Z"]]:
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                calculate([{"id": "OBV"}], [{**bar, "time": label} for bar, label in zip(bars(2), labels)])

    def test_zero_volume_and_flat_prices_are_valid_and_json_has_no_nan(self):
        observations = [{"time": (datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index)).isoformat(), "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0} for index in range(40)]
        response = calculate([{"id": "RSI"}, {"id": "NATR"}, {"id": "OBV"}, {"id": "PPO"}], observations)
        json.dumps(response, allow_nan=False)
        self.assertTrue(all(value == 0 for value in response["results"][2]["series"][0]["values"]))

    def test_maximum_bar_count_and_long_lookback_remain_aligned(self):
        observations = bars(10000)
        response = calculate([{"id": "SMA", "parameters": {"timeperiod": 10000}}], observations)
        values = response["results"][0]["series"][0]["values"]
        self.assertEqual(len(values), 10000)
        self.assertEqual(values[:-1], [None] * 9999)
        self.assertAlmostEqual(values[-1], sum(row["close"] for row in observations) / 10000)


if __name__ == "__main__":
    unittest.main()
