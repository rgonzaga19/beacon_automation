from io import BytesIO
import unittest

from openpyxl import Workbook

from app.domain.soa_excel import _days, _treatment, batch_workbooks


class SoaExcelParserTests(unittest.TestCase):
    def test_apostrophe_full_date_is_accepted_for_treatment_and_epo(self):
        self.assertEqual(_treatment("'September 19, 2026", 9, 2026), (19, 9, 2026))
        self.assertEqual(_days("'September 19, 2026"), {19: 1})

    def test_month_text_epo_keeps_quantity_and_range_formats(self):
        self.assertEqual(_days("Sep 19x2"), {19: 2})
        self.assertEqual(_days("Sep 19-20x2"), {19: 2, 20: 2})

    def test_batch_preview_matches_full_date_epo_to_treatment_day(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append([
            "NAME OF PATIENT",
            "TREATMENT DATES",
            "NO. OF CLAIMS",
            "DATES OF ERYTHROPOIETIN GIVEN\n(WEEKLY)",
            "BETA RECORMON",
            "DIALYZER CATEGORY",
            "KIT CATEGORY",
            "W/ LAB",
        ])
        sheet.append([
            "TEST PATIENT",
            "'September 19, 2026",
            1,
            "'September 19, 2026",
            "",
            "FISTULA",
            "HIGH FLUX",
            "NO",
        ])
        data = BytesIO()
        workbook.save(data)
        data.seek(0)

        preview = batch_workbooks(data, 9, 2026, preview=True)

        self.assertEqual(preview["generated"], 1)
        self.assertEqual(preview["warnings"], [])


if __name__ == "__main__":
    unittest.main()
