from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase

from .models import Transaction, UserProfile
from .services import calculate_user_summary


class TransactionModelTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="testuser", password="testpass123"
        )

    def test_valid_record_creation(self):
        txn = Transaction.objects.create(
            owner=self.user,
            description="Salary",
            activity_type=Transaction.ActivityType.INCOME,
            amount="1000000.00",
            currency="UGX",
            activity_date="2026-01-15",
        )
        self.assertIsNotNone(txn.pk)
        self.assertEqual(txn.activity_type, Transaction.ActivityType.INCOME)
        self.assertEqual(txn.currency, "UGX")
        self.assertEqual(txn.owner, self.user)

    def test_supported_activity_types(self):
        values = [choice.value for choice in Transaction.ActivityType]
        self.assertIn("INCOME", values)
        self.assertIn("EXPENSE", values)
        self.assertIn("TRANSFER", values)

    def test_amount_cannot_be_zero_or_negative(self):
        for bad_amount in ["0.00", "-100.00"]:
            txn = Transaction(
                owner=self.user,
                description="Bad",
                activity_type=Transaction.ActivityType.EXPENSE,
                amount=bad_amount,
                currency="UGX",
                activity_date="2026-01-15",
            )
            with self.assertRaises(ValidationError):
                txn.full_clean()

    def test_owner_is_required(self):
        txn = Transaction(
            description="No owner",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="100.00",
            currency="UGX",
            activity_date="2026-01-15",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                txn.save()

    def test_activity_date_is_separate_from_created_timestamp(self):
        txn = Transaction.objects.create(
            owner=self.user,
            description="Past expense",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="5000.00",
            currency="UGX",
            activity_date="2026-01-01",
        )
        self.assertIsNotNone(txn.created_at)
        self.assertIsNotNone(txn.updated_at)
        self.assertNotEqual(txn.activity_date, txn.created_at.date())


class TransactionAPITests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="apiuser", password="apipass123"
        )
        self.other_user = get_user_model().objects.create_user(
            username="otheruser", password="otherpass123"
        )
        self.client.force_login(self.user)

    def test_anonymous_requests_are_denied(self):
        self.client.logout()
        response = self.client.get("/api/v1/transactions/")
        self.assertEqual(response.status_code, 403)

    def test_authenticated_transaction_creation(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Salary",
                "activity_type": "INCOME",
                "amount": "1000000.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        txn = Transaction.objects.get(pk=response.data["id"])
        self.assertEqual(txn.owner, self.user)

    def test_ownership_assigned_from_authenticated_user(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Salary",
                "activity_type": "INCOME",
                "amount": "1000000.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["owner"], self.user.pk)

    def test_list_only_own_records(self):
        Transaction.objects.create(
            owner=self.user,
            description="Own income",
            activity_type=Transaction.ActivityType.INCOME,
            amount="1000000.00",
            currency="UGX",
            activity_date="2026-01-15",
        )
        Transaction.objects.create(
            owner=self.other_user,
            description="Other income",
            activity_type=Transaction.ActivityType.INCOME,
            amount="500000.00",
            currency="UGX",
            activity_date="2026-01-15",
        )
        response = self.client.get("/api/v1/transactions/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data["results"]), 1)
        self.assertEqual(response.data["results"][0]["description"], "Own income")

    def test_retrieve_only_own_records(self):
        own_txn = Transaction.objects.create(
            owner=self.user,
            description="Own expense",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="5000.00",
            currency="UGX",
            activity_date="2026-01-01",
        )
        other_txn = Transaction.objects.create(
            owner=self.other_user,
            description="Other expense",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="3000.00",
            currency="UGX",
            activity_date="2026-01-02",
        )
        response = self.client.get(f"/api/v1/transactions/{own_txn.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], own_txn.pk)

        response = self.client.get(f"/api/v1/transactions/{other_txn.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_invalid_amount_rejected(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Bad",
                "activity_type": "EXPENSE",
                "amount": "0.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("amount", response.data)

    def test_negative_amount_rejected(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Bad",
                "activity_type": "EXPENSE",
                "amount": "-100.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("amount", response.data)

    def test_invalid_activity_type_rejected(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Bad",
                "activity_type": "BONUS",
                "amount": "100.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("activity_type", response.data)

    def test_client_cannot_override_ownership(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Hijack",
                "activity_type": "INCOME",
                "amount": "100.00",
                "currency": "UGX",
                "activity_date": "2026-01-15",
                "owner": self.other_user.pk,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        txn = Transaction.objects.get(pk=response.data["id"])
        self.assertEqual(txn.owner, self.user)

    def test_missing_required_fields_rejected(self):
        response = self.client.post(
            "/api/v1/transactions/",
            {
                "description": "Incomplete",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
class UserProfileTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="profileuser", password="profilepass123"
        )

    def test_valid_profile_creation(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
            preferred_name="Sam",
        )
        self.assertIsNotNone(profile.pk)
        self.assertEqual(profile.user, self.user)
        self.assertEqual(profile.phone_number, "+256700123456")
        self.assertEqual(profile.preferred_name, "Sam")

    def test_phone_number_is_unique(self):
        UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
        )
        other_user = get_user_model().objects.create_user(
            username="otheruser", password="otherpass123"
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                UserProfile.objects.create(
                    user=other_user,
                    phone_number="+256700123456",
                )

    def test_phone_number_is_not_primary_key(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
        )
        self.assertNotEqual(profile.pk, profile.phone_number)
        self.assertIsInstance(profile.pk, int)

    def test_phone_number_normalization(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="0700 123 456",
        )
        self.assertEqual(profile.phone_number, "+256700123456")

    def test_phone_number_normalization_with_dashes(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256-700-123-456",
        )
        self.assertEqual(profile.phone_number, "+256700123456")

    def test_phone_number_normalization_with_double_zero_prefix(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="00256700123456",
        )
        self.assertEqual(profile.phone_number, "+256700123456")

    def test_empty_phone_number_rejected(self):
        profile = UserProfile(
            user=self.user,
            phone_number="",
            preferred_name="Sam",
        )
        with self.assertRaises(ValidationError):
            profile.full_clean()

    def test_preferred_name_is_separate_from_phone_number(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
            preferred_name="Sam",
        )
        self.assertEqual(profile.preferred_name, "Sam")
        self.assertNotEqual(profile.preferred_name, profile.phone_number)

    def test_preferred_name_can_be_updated(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
            preferred_name="Sam",
        )
        profile.preferred_name = "Samantha"
        profile.save()
        profile.refresh_from_db()
        self.assertEqual(profile.preferred_name, "Samantha")

    def test_preferred_name_can_be_blank(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
        )
        self.assertEqual(profile.preferred_name, "")

    def test_user_to_profile_relationship(self):
        profile = UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
            preferred_name="Sam",
        )
        self.assertEqual(self.user.profile, profile)

    def test_lookup_by_phone_number_recognizes_returning_user(self):
        UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
            preferred_name="Sam",
        )
        found = UserProfile.lookup_by_phone_number("0700 123 456")
        self.assertIsNotNone(found)
        self.assertEqual(found.user, self.user)

    def test_lookup_by_unknown_phone_number_returns_none(self):
        found = UserProfile.lookup_by_phone_number("+256700999999")
        self.assertIsNone(found)

    def test_one_user_cannot_have_multiple_profiles(self):
        UserProfile.objects.create(
            user=self.user,
            phone_number="+256700123456",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                UserProfile.objects.create(
                    user=self.user,
                    phone_number="+256700999999",
                )


class FinancialSummaryServiceTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="summaryuser", password="summarypass123"
        )
        self.other_user = get_user_model().objects.create_user(
            username="othersummaryuser", password="othersummarypass123"
        )

    def _create_txn(self, user, activity_type, amount, currency, activity_date):
        return Transaction.objects.create(
            owner=user,
            description=f"{activity_type} {amount} {currency}",
            activity_type=activity_type,
            amount=amount,
            currency=currency,
            activity_date=activity_date,
        )

    def test_normal_income_and_expense_summary(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.user, Transaction.ActivityType.EXPENSE, "300000.00", "UGX", date(2026, 1, 15))

        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        self.assertEqual(len(summaries), 1)
        summary = summaries[0]
        self.assertEqual(summary.currency, "UGX")
        self.assertEqual(summary.income_total, Decimal("1000000.00"))
        self.assertEqual(summary.expense_total, Decimal("300000.00"))
        self.assertEqual(summary.net_cash_flow, Decimal("700000.00"))
        self.assertEqual(summary.income_count, 1)
        self.assertEqual(summary.expense_count, 1)
        self.assertEqual(summary.transfer_count, 0)

    def test_transfers_excluded_from_totals(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.user, Transaction.ActivityType.EXPENSE, "200000.00", "UGX", date(2026, 1, 15))
        self._create_txn(self.user, Transaction.ActivityType.TRANSFER, "500000.00", "UGX", date(2026, 1, 20))

        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        summary = summaries[0]
        self.assertEqual(summary.income_total, Decimal("1000000.00"))
        self.assertEqual(summary.expense_total, Decimal("200000.00"))
        self.assertEqual(summary.net_cash_flow, Decimal("800000.00"))
        self.assertEqual(summary.income_count, 1)
        self.assertEqual(summary.expense_count, 1)
        self.assertEqual(summary.transfer_count, 1)

    def test_date_boundaries_are_inclusive(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000.00", "UGX", date(2026, 1, 1))
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "2000.00", "UGX", date(2026, 1, 31))
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "3000.00", "UGX", date(2026, 2, 1))

        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        summary = summaries[0]
        self.assertEqual(summary.income_total, Decimal("3000.00"))
        self.assertEqual(summary.income_count, 2)

    def test_empty_results_return_zero(self):
        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        self.assertEqual(summaries, [])

    def test_multiple_currencies_are_grouped_separately(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "500.00", "USD", date(2026, 1, 10))

        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        self.assertEqual(len(summaries), 2)

        ugx = summaries[0]
        usd = summaries[1]
        self.assertEqual(ugx.currency, "UGX")
        self.assertEqual(ugx.income_total, Decimal("1000.00"))
        self.assertEqual(usd.currency, "USD")
        self.assertEqual(usd.income_total, Decimal("500.00"))

    def test_user_isolation(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.other_user, Transaction.ActivityType.INCOME, "9999999.00", "UGX", date(2026, 1, 10))

        summaries = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0].income_total, Decimal("1000000.00"))
        self.assertEqual(summaries[0].income_count, 1)

    def test_reversed_date_range_raises(self):
        with self.assertRaises(ValueError):
            calculate_user_summary(self.user, date(2026, 2, 1), date(2026, 1, 1))


class SummaryAPITests(TestCase):

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="api_summary_user", password="apipass123"
        )
        self.other_user = get_user_model().objects.create_user(
            username="other_api_summary_user", password="otherpass123"
        )
        self.client.force_login(self.user)

    def _create_txn(self, user, activity_type, amount, currency, activity_date):
        return Transaction.objects.create(
            owner=user,
            description=f"{activity_type} {amount} {currency}",
            activity_type=activity_type,
            amount=amount,
            currency=currency,
            activity_date=activity_date,
        )

    def test_anonymous_requests_are_denied(self):
        self.client.logout()
        response = self.client.get("/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31")
        self.assertEqual(response.status_code, 403)

    def test_missing_dates_are_rejected(self):
        response = self.client.get("/api/v1/summaries/")
        self.assertEqual(response.status_code, 400)

        response = self.client.get("/api/v1/summaries/?start_date=2026-01-01")
        self.assertEqual(response.status_code, 400)

    def test_invalid_date_format_is_rejected(self):
        response = self.client.get(
            "/api/v1/summaries/?start_date=not-a-date&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 400)

    def test_reversed_date_range_is_rejected(self):
        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-02-01&end_date=2026-01-01"
        )
        self.assertEqual(response.status_code, 400)

    def test_authenticated_summary_retrieval(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.user, Transaction.ActivityType.EXPENSE, "300000.00", "UGX", date(2026, 1, 15))

        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["currency"], "UGX")
        self.assertEqual(data[0]["income_total"], "1000000.00")
        self.assertEqual(data[0]["expense_total"], "300000.00")
        self.assertEqual(data[0]["net_cash_flow"], "700000.00")
        self.assertEqual(data[0]["income_count"], 1)
        self.assertEqual(data[0]["expense_count"], 1)
        self.assertEqual(data[0]["transfer_count"], 0)

    def test_api_only_summarizes_current_users_records(self):
        self._create_txn(self.user, Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.other_user, Transaction.ActivityType.INCOME, "9999999.00", "UGX", date(2026, 1, 10))

        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["income_total"], "1000000.00")

    def test_empty_range_returns_empty_list(self):
        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])


class TransactionUpdateDestroyAPITests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="update_user", password="updatepass123"
        )
        self.other_user = get_user_model().objects.create_user(
            username="other_update_user", password="otherupdatepass123"
        )
        self.client.force_login(self.user)

    def _create_txn(self, activity_type, amount, currency, activity_date):
        return Transaction.objects.create(
            owner=self.user,
            description=f"{activity_type} {amount} {currency}",
            activity_type=activity_type,
            amount=amount,
            currency=currency,
            activity_date=activity_date,
        )

    def test_authenticated_patch_update_transaction(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"description": "Updated groceries", "amount": "75000.00"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertEqual(txn.description, "Updated groceries")
        self.assertEqual(txn.amount, Decimal("75000.00"))

    def test_patch_only_updates_provided_fields(self):
        txn = self._create_txn(
            Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 15)
        )
        original_created = txn.created_at
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"description": "Partial update only"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertEqual(txn.description, "Partial update only")
        self.assertEqual(txn.amount, Decimal("1000000.00"))
        self.assertEqual(txn.created_at, original_created)

    def test_patch_update_activity_type_and_currency(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {
                "activity_type": Transaction.ActivityType.INCOME,
                "currency": "USD",
                "activity_date": date(2026, 2, 1).isoformat(),
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertEqual(txn.activity_type, Transaction.ActivityType.INCOME)
        self.assertEqual(txn.currency, "USD")
        self.assertEqual(txn.activity_date, date(2026, 2, 1))

    def test_patch_rejects_invalid_amount(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"amount": "0.00"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("amount", response.data)

    def test_patch_rejects_negative_amount(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"amount": "-100.00"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("amount", response.data)

    def test_patch_rejects_unsupported_activity_type(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"activity_type": "BONUS"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("activity_type", response.data)

    def test_patch_rejects_invalid_date(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"activity_date": "not-a-date"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("activity_date", response.data)

    def test_patch_cannot_change_owner(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"owner": self.other_user.pk},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertEqual(txn.owner, self.user)

    def test_patch_does_not_modify_created_at(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        original_created = txn.created_at
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"description": "Changed"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertEqual(txn.created_at, original_created)

    def test_authenticated_delete_transaction(self):
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.delete(f"/api/v1/transactions/{txn.pk}/")
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Transaction.objects.filter(pk=txn.pk).exists())

    def test_delete_another_users_transaction_returns_404(self):
        other_txn = Transaction.objects.create(
            owner=self.other_user,
            description="Other user txn",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="50000.00",
            currency="UGX",
            activity_date=date(2026, 1, 10),
        )
        response = self.client.delete(f"/api/v1/transactions/{other_txn.pk}/")
        self.assertEqual(response.status_code, 404)
        self.assertTrue(Transaction.objects.filter(pk=other_txn.pk).exists())

    def test_retrieve_another_users_transaction_returns_404(self):
        other_txn = Transaction.objects.create(
            owner=self.other_user,
            description="Other user txn",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="50000.00",
            currency="UGX",
            activity_date=date(2026, 1, 10),
        )
        response = self.client.get(f"/api/v1/transactions/{other_txn.pk}/")
        self.assertEqual(response.status_code, 404)

    def test_patch_another_users_transaction_returns_404(self):
        other_txn = Transaction.objects.create(
            owner=self.other_user,
            description="Other user txn",
            activity_type=Transaction.ActivityType.EXPENSE,
            amount="50000.00",
            currency="UGX",
            activity_date=date(2026, 1, 10),
        )
        response = self.client.patch(
            f"/api/v1/transactions/{other_txn.pk}/",
            {"description": "Hacked"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)

    def test_anonymous_patch_denied(self):
        self.client.logout()
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"description": "Hacked"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_anonymous_delete_denied(self):
        self.client.logout()
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "50000.00", "UGX", date(2026, 1, 10)
        )
        response = self.client.delete(f"/api/v1/transactions/{txn.pk}/")
        self.assertEqual(response.status_code, 403)

    def test_summary_reflects_updated_transaction(self):
        txn = self._create_txn(
            Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10)
        )
        self.client.patch(
            f"/api/v1/transactions/{txn.pk}/",
            {"amount": "1500000.00"},
            content_type="application/json",
        )
        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["income_total"], "1500000.00")

    def test_summary_reflects_deleted_transaction(self):
        self._create_txn(
            Transaction.ActivityType.INCOME, "1000000.00", "UGX", date(2026, 1, 10)
        )
        txn = self._create_txn(
            Transaction.ActivityType.EXPENSE, "300000.00", "UGX", date(2026, 1, 15)
        )
        self.client.delete(f"/api/v1/transactions/{txn.pk}/")
        response = self.client.get(
            "/api/v1/summaries/?start_date=2026-01-01&end_date=2026-01-31"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["expense_total"], "0.00")
        self.assertEqual(data[0]["expense_count"], 0)