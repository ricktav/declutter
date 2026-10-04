# scripts/collectors/energy/test_report_energy.py
import unittest
from report_energy_homebase import aggregate, is_offpeak, months_to_send
from datetime import datetime

class AggregateTest(unittest.TestCase):
    def test_offpeak_hours(self):
        self.assertTrue(is_offpeak(datetime(2026, 10, 3, 12)))   # Saturday
        self.assertTrue(is_offpeak(datetime(2026, 10, 5, 23)))   # Monday 23:00
        self.assertTrue(is_offpeak(datetime(2026, 10, 5, 6, 45)))
        self.assertFalse(is_offpeak(datetime(2026, 10, 5, 7)))
        self.assertFalse(is_offpeak(datetime(2026, 10, 5, 22, 45)))

    def test_month_figures(self):
        rows = [("2026-10-05T12:00:00", 100.0, 120.0), ("2026-10-05T23:00:00", 40.0, 50.0), ("2026-10-05T23:15:00", -0.3, 0.0)]
        m = aggregate(rows)["2026-10"]
        self.assertAlmostEqual(m["kwhNormal"], 0.025)          # 100 W x 0.25 h
        self.assertAlmostEqual(m["kwhOffpeak"], 0.010)         # 40 W x 0.25 h; -0.3 W clamps to 0
        self.assertEqual(m["hours"], 0.8)                      # 3 x 0.25 h, one decimal like the column
        self.assertEqual(m["peakW"], 120.0)
        self.assertGreaterEqual(m["baseW"], 0)                 # never negative
        self.assertAlmostEqual(m["avgW"], round(0.035 * 1000 / 0.75, 1))

    def test_nightly_months(self):
        self.assertEqual(months_to_send(datetime(2026, 10, 1, 1)), ["2026-09", "2026-10"])
        self.assertEqual(months_to_send(datetime(2026, 1, 15, 1)), ["2025-12", "2026-01"])

if __name__ == "__main__":
    unittest.main()
