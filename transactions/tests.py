from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings

from .models import Country, Currency, PendingAction, ProcessedMessage, Transaction, UserProfile
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

    def test_new_transfer_entries_are_rejected(self):
        response = self.client.post("/api/v1/transactions/", {
            "description": "Move between accounts", "activity_type": "TRANSFER", "amount": "1000",
            "currency": "UGX", "activity_date": "2026-01-15",
        }, content_type="application/json")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Transaction.objects.filter(description="Move between accounts").exists())

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

    def test_transaction_search_is_scoped_and_excludes_voided_records(self):
        Transaction.objects.create(owner=self.user, description="Campus lunch", category="FOOD", activity_type="EXPENSE", amount="15000", currency="UGX", activity_date="2026-01-15")
        Transaction.objects.create(owner=self.other_user, description="Campus lunch", category="FOOD", activity_type="EXPENSE", amount="15000", currency="UGX", activity_date="2026-01-15")
        hidden = Transaction.objects.create(owner=self.user, description="Old lunch", activity_type="EXPENSE", amount="15000", currency="UGX", activity_date="2026-01-15", is_voided=True)
        response = self.client.get("/api/v1/transactions/?search=lunch&amount=15000")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["description"] for row in response.data["results"]], ["Campus lunch"])
        self.assertNotIn(hidden.pk, [row["id"] for row in response.data["results"]])

    def test_pending_action_is_persisted_and_scoped_to_profile(self):
        profile = UserProfile.objects.create(user=self.user, phone_number="+256787360381", preferred_name="Sam")
        response = self.client.post("/api/v1/pending-action/", {
            "action_type": "TRANSACTION", "payload": {"amount": "15000"}, "original_message_id": "ask-1",
        }, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(PendingAction.objects.get(profile=profile).payload["amount"], "15000")
        self.assertEqual(self.client.get("/api/v1/pending-action/").data["pending"]["action_type"], "TRANSACTION")

    def test_void_endpoint_retains_record_and_is_idempotent(self):
        record = Transaction.objects.create(owner=self.user, description="Lunch", activity_type="EXPENSE", amount="15000", currency="UGX", activity_date="2026-01-15")
        first = self.client.post(f"/api/v1/transactions/{record.pk}/void/", {"reason": "UNDO"}, content_type="application/json", HTTP_X_WHATSAPP_MESSAGE_ID="undo-1")
        second = self.client.post(f"/api/v1/transactions/{record.pk}/void/", {"reason": "UNDO"}, content_type="application/json", HTTP_X_WHATSAPP_MESSAGE_ID="undo-1")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        record.refresh_from_db()
        self.assertTrue(record.is_voided)
        self.assertEqual(record.void_reason, "UNDO")
        self.assertEqual(ProcessedMessage.objects.filter(message_id="undo-1").count(), 1)
        self.assertFalse(self.client.get("/api/v1/transactions/").data["results"])

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


class CountryCurrencyModelTests(TestCase):
    def test_seeded_uganda_and_ugx_are_active_and_related(self):
        uganda = Country.objects.get(country_code="UG")
        ugx = Currency.objects.get(code="UGX")
        self.assertTrue(uganda.is_active)
        self.assertEqual(uganda.default_currency, ugx)
        self.assertTrue(uganda.currencies.filter(pk=ugx.pk).exists())
        self.assertEqual(ugx.name, "Ugandan shilling")

    def test_currency_code_validation_and_normalization(self):
        currency = Currency(code="kes", name="Kenyan shilling")
        currency.full_clean()
        self.assertEqual(currency.code, "KES")
        with self.assertRaises(ValidationError):
            Currency(code="U1X", name="Invalid").full_clean()

    def test_country_code_validation_and_normalization(self):
        currency = Currency.objects.get(code="UGX")
        country = Country(name="Test", country_code="ke", default_currency=currency)
        country.full_clean()
        self.assertEqual(country.country_code, "KE")
        with self.assertRaises(ValidationError):
            Country(name="Invalid", country_code="USA", default_currency=currency).full_clean()

    def test_user_preferences_may_remain_empty_for_legacy_profiles(self):
        user = get_user_model().objects.create_user(username="legacy-profile")
        profile = UserProfile.objects.create(user=user, phone_number="+256700000111")
        self.assertIsNone(profile.country_id)
        self.assertIsNone(profile.preferred_currency_id)


@override_settings(DJANGO_SERVICE_KEY="test-service-key")
class WhatsAppOnboardingAPITests(TestCase):
    endpoint = "/api/v1/onboarding/"

    def post_profile(self, phone="256700123456", name="Sam", service_key="test-service-key"):
        return self.client.post(
            self.endpoint,
            {"phone_number": phone, "preferred_name": name},
            content_type="application/json",
            HTTP_X_SERVICE_KEY=service_key,
        )

    def test_onboarding_creates_user_and_phone_profile(self):
        response = self.post_profile()
        self.assertEqual(response.status_code, 201)
        profile = UserProfile.objects.get(phone_number="+256700123456")
        self.assertEqual(profile.preferred_name, "Sam")
        self.assertFalse(profile.user.has_usable_password())

    def test_onboarding_updates_existing_profile_idempotently(self):
        self.post_profile()
        response = self.post_profile(name="Samantha")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(UserProfile.objects.filter(phone_number="+256700123456").count(), 1)
        self.assertEqual(UserProfile.objects.get(phone_number="+256700123456").preferred_name, "Samantha")

    def test_onboarding_requires_service_key_and_valid_fields(self):
        self.assertEqual(self.post_profile(service_key="wrong").status_code, 403)
        self.assertEqual(self.post_profile(phone="not-a-phone").status_code, 400)
        self.assertEqual(self.post_profile(name=" ").status_code, 400)

    def test_only_active_configured_countries_are_selectable(self):
        response = self.client.get("/api/v1/countries/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([country["country_code"] for country in response.data], ["UG"])

        kes = Currency.objects.create(code="KES", name="Kenyan shilling", is_active=True)
        kenya = Country.objects.create(name="Kenya", country_code="KE", default_currency=kes, is_active=False)
        kenya.currencies.add(kes)
        response = self.client.get("/api/v1/countries/")
        self.assertEqual([country["country_code"] for country in response.data], ["UG"])

    def test_country_selection_assigns_the_configured_default_currency(self):
        self.post_profile(name="Sam")
        response = self.client.post(
            self.endpoint,
            {"phone_number": "256700123456", "country_code": "ug"},
            content_type="application/json",
            HTTP_X_SERVICE_KEY="test-service-key",
        )
        self.assertEqual(response.status_code, 200)
        profile = UserProfile.objects.get(phone_number="+256700123456")
        self.assertEqual(profile.preferred_name, "Sam")
        self.assertEqual(profile.country.country_code, "UG")
        self.assertEqual(profile.preferred_currency.code, "UGX")

    def test_inactive_country_cannot_be_selected_and_existing_profile_is_preserved(self):
        self.post_profile(name="Sam")
        kes = Currency.objects.create(code="KES", name="Kenyan shilling")
        kenya = Country.objects.create(name="Kenya", country_code="KE", default_currency=kes, is_active=False)
        kenya.currencies.add(kes)
        response = self.client.post(
            self.endpoint,
            {"phone_number": "256700123456", "country_code": "KE"},
            content_type="application/json",
            HTTP_X_SERVICE_KEY="test-service-key",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(UserProfile.objects.filter(phone_number="+256700123456").count(), 1)
        self.assertIsNone(UserProfile.objects.get(phone_number="+256700123456").country_id)

    def test_status_reports_saved_name_and_country_step(self):
        self.post_profile(name="Sam")
        response = self.client.get(
            "/api/v1/onboarding/status/",
            HTTP_X_SERVICE_KEY="test-service-key",
            HTTP_X_WHATSAPP_PHONE="256700123456",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["registered"])
        self.assertEqual(response.data["preferred_name"], "Sam")
        self.assertTrue(response.data["needs_country"])


@override_settings(DJANGO_SERVICE_KEY="test-service-key")
class WhatsAppTransactionIdempotencyTests(TestCase):
    endpoint = "/api/v1/transactions/"

    def setUp(self):
        self.user = get_user_model().objects.create_user(username="wa_user", password=None)
        self.profile = UserProfile.objects.create(user=self.user, phone_number="+256700123456")

    def post_transaction(self, message_id="message-id-1", phone="256700123456", payload=None):
        body = payload or {
            "description": "Lunch",
            "activity_type": "EXPENSE",
            "amount": "15000.00",
            "currency": "UGX",
            "activity_date": "2026-10-21",
        }
        return self.client.post(
            self.endpoint,
            body,
            content_type="application/json",
            HTTP_X_SERVICE_KEY="test-service-key",
            HTTP_X_WHATSAPP_PHONE=phone,
            HTTP_X_WHATSAPP_MESSAGE_ID=message_id,
        )

    def test_redelivered_message_returns_saved_transaction_without_duplicate(self):
        first = self.post_transaction()
        second = self.post_transaction()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(Transaction.objects.filter(owner=self.user).count(), 1)
        self.assertEqual(ProcessedMessage.objects.get(message_id="message-id-1").transaction_id, first.data["id"])

    def test_failed_validation_does_not_consume_message_id(self):
        invalid = self.post_transaction(payload={"description": "Missing fields"})
        valid = self.post_transaction()
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(valid.status_code, 201)
        self.assertEqual(Transaction.objects.filter(owner=self.user).count(), 1)

    def test_message_id_cannot_reveal_another_users_transaction(self):
        first = self.post_transaction()
        other_user = get_user_model().objects.create_user(username="wa_other", password=None)
        UserProfile.objects.create(user=other_user, phone_number="+256700999999")
        replay = self.post_transaction(phone="256700999999")
        self.assertEqual(first.status_code, 201)
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(Transaction.objects.count(), 1)


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

    def test_refunds_and_loans_have_separate_totals_and_cash_flow(self):
        self._create_txn(self.user, Transaction.ActivityType.REFUND, "100.00", "UGX", date(2026, 1, 10))
        self._create_txn(self.user, Transaction.ActivityType.LOAN_RECEIVED, "500.00", "UGX", date(2026, 1, 11))
        self._create_txn(self.user, Transaction.ActivityType.LOAN_REPAYMENT, "150.00", "UGX", date(2026, 1, 12))
        summary = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))[0]
        self.assertEqual(summary.refund_total, Decimal("100.00"))
        self.assertEqual(summary.loan_received_total, Decimal("500.00"))
        self.assertEqual(summary.loan_repayment_total, Decimal("150.00"))
        self.assertEqual(summary.net_cash_flow, Decimal("450.00"))

    def test_lending_repayments_gifts_and_asset_sales_remain_distinct(self):
        for activity, amount in [
            (Transaction.ActivityType.LOAN_GIVEN, "200.00"),
            (Transaction.ActivityType.LOAN_REPAYMENT_RECEIVED, "50.00"),
            (Transaction.ActivityType.GIFT_RECEIVED, "30.00"),
            (Transaction.ActivityType.ASSET_SALE, "120.00"),
        ]:
            self._create_txn(self.user, activity, amount, "UGX", date(2026, 1, 10))
        summary = calculate_user_summary(self.user, date(2026, 1, 1), date(2026, 1, 31))[0]
        self.assertEqual(summary.loan_given_total, Decimal("200.00"))
        self.assertEqual(summary.loan_repayment_received_total, Decimal("50.00"))
        self.assertEqual(summary.gift_received_total, Decimal("30.00"))
        self.assertEqual(summary.asset_sale_total, Decimal("120.00"))
        self.assertEqual(summary.net_cash_flow, Decimal("0.00"))

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
        self.assertEqual(response.status_code, 200)
        txn.refresh_from_db()
        self.assertTrue(txn.is_voided)
        self.assertEqual(txn.void_reason, "DELETE")
        self.assertTrue(Transaction.objects.filter(pk=txn.pk).exists())

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


class StageThreeInsightsAndPrivacyAPITests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="stage3-user", password="pass123")
        self.other = get_user_model().objects.create_user(username="stage3-other", password="pass123")
        self.client.force_login(self.user)

    def create_transaction(self, owner, description, kind, amount, category, day, currency="UGX"):
        return Transaction.objects.create(owner=owner, description=description, activity_type=kind, amount=amount, category=category, currency=currency, activity_date=day)

    def test_insights_calculate_categories_top_records_and_comparison_per_currency(self):
        self.create_transaction(self.user, "Lunch at Africana Hotel", "EXPENSE", "15000", "FOOD", date(2026, 10, 15))
        self.create_transaction(self.user, "Hotel room", "EXPENSE", "40000", "HOUSING", date(2026, 10, 15))
        self.create_transaction(self.user, "Lunch last month", "EXPENSE", "10000", "FOOD", date(2026, 9, 15))
        self.create_transaction(self.user, "Salary", "INCOME", "100000", "SALARY", date(2026, 10, 1))
        self.create_transaction(self.other, "Other user's hotel", "EXPENSE", "900000", "HOUSING", date(2026, 10, 15))
        response = self.client.get("/api/v1/insights/?start_date=2026-10-01&end_date=2026-10-31&compare_start_date=2026-09-01&compare_end_date=2026-09-30&search=AFRICANA")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["transaction_count"], 1)
        self.assertEqual(response.data["matching_transactions"][0]["description"], "Lunch at Africana Hotel")
        self.assertEqual(response.data["currencies"][0]["expense_total"], Decimal("15000"))
        self.assertEqual(response.data["largest_expenses"][0]["amount"], Decimal("15000"))

    def test_insights_comparison_excludes_other_users_and_keeps_currencies_separate(self):
        self.create_transaction(self.user, "Current UGX", "EXPENSE", "30000", "FOOD", date(2026, 10, 10))
        self.create_transaction(self.user, "Prior UGX", "EXPENSE", "20000", "FOOD", date(2026, 9, 10))
        self.create_transaction(self.user, "Current USD", "EXPENSE", "10", "FOOD", date(2026, 10, 11), "USD")
        self.create_transaction(self.other, "Other", "EXPENSE", "999999", "FOOD", date(2026, 10, 11))
        response = self.client.get("/api/v1/insights/?start_date=2026-10-01&end_date=2026-10-31&compare_start_date=2026-09-01&compare_end_date=2026-09-30")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["currency"] for row in response.data["currencies"]], ["UGX", "USD"])
        self.assertEqual(len(response.data["comparisons"]), 2)
        self.assertEqual([row["currency"] for row in response.data["largest_expenses"]], ["UGX", "USD"])
        self.assertEqual(response.data["comparisons"][0]["current_expense_total"], Decimal("30000"))

    def test_account_deletion_removes_only_confirmed_authenticated_users_data(self):
        profile = UserProfile.objects.create(user=self.user, phone_number="+256700000001", preferred_name="Stage Three")
        txn = self.create_transaction(self.user, "Lunch", "EXPENSE", "15000", "FOOD", date(2026, 10, 15))
        ProcessedMessage.objects.create(message_id="stage3-owned-message", transaction=txn)
        other_txn = self.create_transaction(self.other, "Other lunch", "EXPENSE", "20000", "FOOD", date(2026, 10, 15))
        ProcessedMessage.objects.create(message_id="stage3-other-message", transaction=other_txn)
        response = self.client.delete("/api/v1/account/data/", HTTP_X_WHATSAPP_MESSAGE_ID="confirmed-delete-1")
        self.assertEqual(response.status_code, 204)
        self.assertFalse(get_user_model().objects.filter(pk=self.user.pk).exists())
        self.assertFalse(UserProfile.objects.filter(pk=profile.pk).exists())
        self.assertFalse(Transaction.objects.filter(pk=txn.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=other_txn.pk).exists())
        self.assertEqual(ProcessedMessage.objects.filter(message_id="stage3-owned-message").count(), 0)
        self.assertEqual(ProcessedMessage.objects.filter(message_id="stage3-other-message").count(), 1)

    def test_insights_reject_incomplete_comparison_range(self):
        response = self.client.get("/api/v1/insights/?start_date=2026-10-01&end_date=2026-10-31&compare_start_date=2026-09-01")
        self.assertEqual(response.status_code, 400)
