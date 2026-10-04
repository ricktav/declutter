# scripts/collectors/energy/test_report_house.py
import unittest
from report_house_energy import grid_months, solar_months

class HouseTest(unittest.TestCase):
    def test_grid_sums_days_per_month_t2_normal_t1_offpeak(self):
        days = [
            {"day": "2026-09-29", "electricity1": "10.5", "electricity2": "2.0", "electricity1_returned": "1.0", "electricity2_returned": "4.0"},
            {"day": "2026-09-30", "electricity1": "9.5", "electricity2": "1.0", "electricity1_returned": "0.0", "electricity2_returned": "6.0"},
            {"day": "2026-10-01", "electricity1": "8.0", "electricity2": "0.0", "electricity1_returned": "0.5", "electricity2_returned": "0.0"},
        ]
        m = {x["month"]: x for x in grid_months(days)}
        self.assertEqual(m["2026-09"], {"month": "2026-09", "kwhNormal": 3.0, "kwhOffpeak": 20.0, "kwhReturnedNormal": 10.0, "kwhReturnedOffpeak": 1.0, "hours": 48.0})
        self.assertEqual(m["2026-10"]["hours"], 24.0)

    def test_solar_skips_empty_months_and_converts_wh(self):
        values = [{"date": "2026-08-01 00:00:00", "value": 512340.0}, {"date": "2026-09-01 00:00:00", "value": None}]
        self.assertEqual(solar_months(values), [{"month": "2026-08", "kwhProduced": 512.34}])

if __name__ == "__main__":
    unittest.main()
