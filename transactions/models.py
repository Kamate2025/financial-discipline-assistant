from decimal import Decimal

import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models


class Transaction(models.Model):
    """A single personal financial record.

    Legacy transfers remain readable. New supported types distinguish income,
    expenses, refunds, loan advances, and loan repayments.
    """

    class ActivityType(models.TextChoices):
        INCOME = "INCOME", "Income"
        EXPENSE = "EXPENSE", "Expense"
        REFUND = "REFUND", "Refund"
        LOAN_RECEIVED = "LOAN_RECEIVED", "Loan received"
        LOAN_REPAYMENT = "LOAN_REPAYMENT", "Loan repayment"
        # Retained so existing records and clients remain compatible.
        TRANSFER = "TRANSFER", "Transfer"

    class Category(models.TextChoices):
        FOOD = "FOOD", "Food"
        TRANSPORT = "TRANSPORT", "Transport"
        HOUSING = "HOUSING", "Housing"
        UTILITIES = "UTILITIES", "Utilities"
        HEALTH = "HEALTH", "Health"
        EDUCATION = "EDUCATION", "Education"
        SHOPPING = "SHOPPING", "Shopping"
        ENTERTAINMENT = "ENTERTAINMENT", "Entertainment"
        SALARY = "SALARY", "Salary"
        PERSONAL = "PERSONAL", "Personal"
        OTHER = "OTHER", "Other"

    description = models.CharField(max_length=500)
    activity_type = models.CharField(max_length=20, choices=ActivityType.choices)
    category = models.CharField(max_length=20, choices=Category.choices, blank=True, default="")
    amount = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.01"))],
        help_text="Must be greater than zero.",
    )
    currency = models.CharField(max_length=3, default="UGX")
    activity_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="transactions",
    )
    is_voided = models.BooleanField(default=False)
    voided_at = models.DateTimeField(null=True, blank=True)
    void_reason = models.CharField(max_length=30, blank=True, default="")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0),
                name="transactions_amount_positive",
            )
        ]
        ordering = ["-activity_date", "-created_at"]

    def __str__(self):
        return f"{self.description} - {self.amount} {self.currency}"


class Currency(models.Model):
    """Administrator-managed currency metadata."""

    code = models.CharField(max_length=3, unique=True)
    name = models.CharField(max_length=100)
    symbol = models.CharField(max_length=8, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]

    def clean(self):
        super().clean()
        self.code = self.code.strip().upper()
        if len(self.code) != 3 or not self.code.isalpha():
            raise ValidationError({"code": "Enter a three-letter currency code."})

    def save(self, *args, **kwargs):
        self.code = self.code.strip().upper()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code} — {self.name}"


class Country(models.Model):
    """A selectable country with its supported and default currencies."""

    name = models.CharField(max_length=100)
    country_code = models.CharField(max_length=2, unique=True)
    currencies = models.ManyToManyField(Currency, related_name="countries", blank=True)
    default_currency = models.ForeignKey(
        Currency,
        on_delete=models.PROTECT,
        related_name="default_for_countries",
    )
    time_zone = models.CharField(max_length=64, default="Africa/Kampala")
    is_active = models.BooleanField(default=False)

    class Meta:
        ordering = ["name"]

    def clean(self):
        super().clean()
        self.country_code = self.country_code.strip().upper()
        if len(self.country_code) != 2 or not self.country_code.isalpha():
            raise ValidationError({"country_code": "Use a two-letter country code."})
        try:
            ZoneInfo(self.time_zone)
        except (ZoneInfoNotFoundError, TypeError):
            raise ValidationError({"time_zone": "Enter a valid IANA time zone."})
        if self.default_currency_id and not self.default_currency.is_active and self.is_active:
            raise ValidationError({"default_currency": "An active country must use an active currency."})
        if self.pk and self.default_currency_id and not self.currencies.filter(pk=self.default_currency_id).exists():
            raise ValidationError({"default_currency": "The default currency must be supported by this country."})

    def save(self, *args, **kwargs):
        self.country_code = self.country_code.strip().upper()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.name} ({self.country_code})"


def normalize_phone_number(value):
    """Normalize a WhatsApp phone number to a consistent international format.

    Removes spaces, dashes, parentheses, and dots. Handles a leading single
    zero as a Ugandan local number (replacing it with the +256 country code)
    and a leading double-zero international prefix as a plus sign. Ensures the
    number starts with a plus sign. Returns the normalized string, or the
    original value if it is empty.
    """
    if not value:
        return value
    normalized = value.strip()
    # Replace a leading double-zero international prefix with a plus sign.
    if normalized.startswith("00"):
        normalized = "+" + normalized[2:]
    # Replace a leading single zero (Ugandan local format) with +256.
    elif normalized.startswith("0"):
        normalized = "+256" + normalized[1:]
    # Remove all remaining spaces, dashes, parentheses, and dots.
    normalized = re.sub(r"[\s\-\(\)\.]", "", normalized)
    # Ensure a leading plus sign.
    if normalized and not normalized.startswith("+"):
        normalized = "+" + normalized
    return normalized


class UserProfile(models.Model):
    """Links a Django user to a normalized WhatsApp phone number and preferred name.

    The phone number is the external identity key used to recognize returning
    WhatsApp users. It is unique but is deliberately not the primary key, so a
    user can update their phone number if needed without rebuilding the record.
    The preferred name is stored separately from the phone number and can be
    changed at any time, including through a future conversational request.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    phone_number = models.CharField(
        max_length=20,
        unique=True,
        help_text="Normalized WhatsApp phone number in international format.",
    )
    preferred_name = models.CharField(
        max_length=100,
        blank=True,
        default="",
        help_text="The user's preferred display name, separate from the phone number.",
    )
    country = models.ForeignKey(
        Country,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="user_profiles",
    )
    preferred_currency = models.ForeignKey(
        Currency,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="user_profiles",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(phone_number__gt=""),
                name="userprofile_phone_number_non_empty",
            )
        ]
        ordering = ["-created_at"]

    def clean(self):
        super().clean()
        self.phone_number = normalize_phone_number(self.phone_number)
        if self.country_id and not self.country.is_active:
            raise ValidationError({"country": "Select an active country."})
        if self.preferred_currency_id and not self.country_id:
            raise ValidationError({"country": "A country is required for the preferred currency."})
        if self.country_id and not self.preferred_currency_id:
            raise ValidationError({"preferred_currency": "A preferred currency is required for a selected country."})
        if self.country_id and self.preferred_currency_id:
            if not self.country.currencies.filter(pk=self.preferred_currency_id, is_active=True).exists():
                raise ValidationError({"preferred_currency": "Select an active currency supported by this country."})

    def save(self, *args, **kwargs):
        self.phone_number = normalize_phone_number(self.phone_number)
        super().save(*args, **kwargs)

    @classmethod
    def lookup_by_phone_number(cls, phone_number):
        """Return the profile matching the normalized phone number, or None."""
        normalized = normalize_phone_number(phone_number)
        return cls.objects.filter(phone_number=normalized).first()

    def __str__(self):
        return f"{self.user.username} - {self.phone_number}"


class ProcessedMessage(models.Model):
    """Records WhatsApp message IDs that have already been processed.

    Prevents duplicate transaction creation when WhatsApp retries message
    delivery, the service reconnects, or an API request times out after the
    transaction has already been saved.
    """

    message_id = models.CharField(max_length=255, unique=True)
    transaction = models.ForeignKey(
        Transaction,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="processed_messages",
    )
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-processed_at"]

    def __str__(self):
        return self.message_id


class PendingAction(models.Model):
    """One short-lived, user-scoped clarification or confirmation at a time."""

    class ActionType(models.TextChoices):
        TRANSACTION = "TRANSACTION", "Transaction clarification"
        CORRECTION = "CORRECTION", "Transaction correction"
        CORRECTION_SELECT = "CORRECTION_SELECT", "Choose transaction to correct"
        DELETE_CONFIRM = "DELETE_CONFIRM", "Confirm transaction deletion"
        UNDO_CONFIRM = "UNDO_CONFIRM", "Confirm transaction undo"
        ACCOUNT_DELETE_CONFIRM = "ACCOUNT_DELETE_CONFIRM", "Confirm account deletion"

    profile = models.OneToOneField(
        UserProfile,
        on_delete=models.CASCADE,
        related_name="pending_action",
    )
    action_type = models.CharField(max_length=24, choices=ActionType.choices)
    payload = models.JSONField(default=dict)
    original_message_id = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.profile_id} - {self.action_type}"
