from datetime import date
from decimal import Decimal, InvalidOperation
from collections import defaultdict

from django.core.exceptions import ValidationError

from .models import Transaction, UserProfile


class FinancialSummary:
    """Result of a financial summary calculation for a single currency.

    Transfers are counted separately and are excluded from income totals,
    expense totals, and net cash flow.
    """

    def __init__(self, currency):
        self.currency = currency
        self.income_total = Decimal("0.00")
        self.expense_total = Decimal("0.00")
        self.refund_total = Decimal("0.00")
        self.loan_received_total = Decimal("0.00")
        self.loan_repayment_total = Decimal("0.00")
        self.income_count = 0
        self.expense_count = 0
        self.refund_count = 0
        self.loan_received_count = 0
        self.loan_repayment_count = 0
        self.transfer_count = 0

    @property
    def net_cash_flow(self):
        return (
            self.income_total
            - self.expense_total
            + self.refund_total
            + self.loan_received_total
            - self.loan_repayment_total
        )


def calculate_user_summary(user, start_date, end_date):
    """Calculate financial summaries for a user within an inclusive date range.

    Returns a list of FinancialSummary objects, one per currency found in the
    user's transactions within the range. Every calculation is filtered by
    ownership, so another user's transactions are never included. Transfers
    are counted separately and excluded from income, expenses, and net cash
    flow. When no transactions exist for a currency, the totals and counts
    are zero.

    Raises ValueError if start_date is after end_date.
    """
    if start_date > end_date:
        raise ValueError("start_date must not be after end_date")

    transactions = Transaction.objects.filter(
        owner=user,
        is_voided=False,
        activity_date__gte=start_date,
        activity_date__lte=end_date,
    ).order_by("currency", "activity_type")

    summaries = {}
    for txn in transactions:
        currency = txn.currency
        if currency not in summaries:
            summaries[currency] = FinancialSummary(currency)

        summary = summaries[currency]
        if txn.activity_type == Transaction.ActivityType.INCOME:
            summary.income_total += txn.amount
            summary.income_count += 1
        elif txn.activity_type == Transaction.ActivityType.EXPENSE:
            summary.expense_total += txn.amount
            summary.expense_count += 1
        elif txn.activity_type == Transaction.ActivityType.REFUND:
            summary.refund_total += txn.amount
            summary.refund_count += 1
        elif txn.activity_type == Transaction.ActivityType.LOAN_RECEIVED:
            summary.loan_received_total += txn.amount
            summary.loan_received_count += 1
        elif txn.activity_type == Transaction.ActivityType.LOAN_REPAYMENT:
            summary.loan_repayment_total += txn.amount
            summary.loan_repayment_count += 1
        elif txn.activity_type == Transaction.ActivityType.TRANSFER:
            summary.transfer_count += 1

    return sorted(summaries.values(), key=lambda s: s.currency)


def calculate_financial_insights(user, start_date, end_date, compare_start=None, compare_end=None, search="", category=""):
    """Return exact, user-scoped insight data without combining currencies."""
    if start_date > end_date or (compare_start and compare_end and compare_start > compare_end):
        raise ValueError("Date ranges must be ordered.")
    base = Transaction.objects.filter(owner=user, is_voided=False)
    if search:
        normalized = " ".join(search.casefold().split())
        # Match normalized whitespace/case at query time without changing data.
        for token in normalized.split():
            base = base.filter(description__icontains=token)
    if category:
        base = base.filter(category__iexact=category)
    current_qs = base.filter(activity_date__gte=start_date, activity_date__lte=end_date)
    current = list(current_qs.order_by("-activity_date", "-pk"))
    expenses_by_currency = defaultdict(list)
    for tx in current:
        if tx.activity_type == Transaction.ActivityType.EXPENSE:
            expenses_by_currency[tx.currency].append(tx)
    largest = []
    for currency in sorted(expenses_by_currency):
        largest.extend(sorted(expenses_by_currency[currency], key=lambda tx: (-tx.amount, -tx.activity_date.toordinal(), -tx.pk))[:5])
    previous = list(base.filter(activity_date__gte=compare_start, activity_date__lte=compare_end).order_by("currency", "activity_type")) if compare_start and compare_end else []

    def aggregate(records):
        data = {}
        categories = defaultdict(lambda: defaultdict(lambda: Decimal("0.00")))
        daily = defaultdict(lambda: defaultdict(lambda: Decimal("0.00")))
        for tx in records:
            row = data.setdefault(tx.currency, {
                "currency": tx.currency, "income_total": Decimal("0.00"), "expense_total": Decimal("0.00"),
                "refund_total": Decimal("0.00"), "loan_received_total": Decimal("0.00"),
                "loan_repayment_total": Decimal("0.00"), "income_count": 0, "expense_count": 0,
                "refund_count": 0, "loan_received_count": 0, "loan_repayment_count": 0,
            })
            kind = tx.activity_type.lower()
            if kind in {"income", "expense", "refund", "loan_received", "loan_repayment"}:
                field = f"{kind}_total"
                row[field] += tx.amount
                row[f"{kind}_count"] += 1
            if tx.activity_type == Transaction.ActivityType.EXPENSE:
                categories[tx.currency][tx.category or "UNCATEGORIZED"] += tx.amount
                daily[tx.currency][tx.activity_date.isoformat()] += tx.amount
        for row in data.values():
            row["net_cash_flow"] = row["income_total"] - row["expense_total"] + row["refund_total"] + row["loan_received_total"] - row["loan_repayment_total"]
            row["category_breakdown"] = [
                {"category": name, "expense_total": amount}
                for name, amount in sorted(categories[row["currency"]].items(), key=lambda item: (-item[1], item[0]))
            ]
            row["daily_expenses"] = [{"date": day, "expense_total": amount} for day, amount in sorted(daily[row["currency"]].items())]
        return data

    current_totals, previous_totals = aggregate(current), aggregate(previous)
    comparisons = []
    for currency in sorted(set(current_totals) | set(previous_totals)):
        now = current_totals.get(currency, {})
        before = previous_totals.get(currency, {})
        now_categories = {x["category"]: x["expense_total"] for x in now.get("category_breakdown", [])}
        old_categories = {x["category"]: x["expense_total"] for x in before.get("category_breakdown", [])}
        changes = [{"category": name, "current_total": now_categories.get(name, Decimal("0.00")), "previous_total": old_categories.get(name, Decimal("0.00")), "change": now_categories.get(name, Decimal("0.00")) - old_categories.get(name, Decimal("0.00"))} for name in sorted(set(now_categories) | set(old_categories))]
        comparisons.append({"currency": currency, "current_expense_total": now.get("expense_total", Decimal("0.00")), "previous_expense_total": before.get("expense_total", Decimal("0.00")), "current_income_total": now.get("income_total", Decimal("0.00")), "previous_income_total": before.get("income_total", Decimal("0.00")), "category_changes": sorted(changes, key=lambda row: (-abs(row["change"]), row["category"]))})

    return {
        "start_date": start_date,
        "end_date": end_date,
        "compare_start_date": compare_start,
        "compare_end_date": compare_end,
        "currencies": [current_totals[key] for key in sorted(current_totals)],
        "comparisons": comparisons,
        "matching_transactions": [{"id": tx.pk, "description": tx.description, "activity_type": tx.activity_type, "category": tx.category, "amount": tx.amount, "currency": tx.currency, "activity_date": tx.activity_date} for tx in current[:100]],
        "largest_expenses": [{"id": tx.pk, "description": tx.description, "category": tx.category, "amount": tx.amount, "currency": tx.currency, "activity_date": tx.activity_date} for tx in largest],
        "transaction_count": len(current),
    }


class TransactionRecordingError(Exception):
    """Raised when a transaction cannot be recorded due to invalid input."""

    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


def record_transaction(user, description, activity_type, amount, currency="UGX", activity_date=None):
    """Record a financial transaction for a user.

    This is the single reusable entry point for creating transactions, used by
    both the API views and the WhatsApp integration. All validation rules from
    the Transaction model are enforced.

    Args:
        user: The Django user who owns the transaction.
        description: Description of the financial activity.
        activity_type: One of INCOME, EXPENSE, or TRANSFER.
        amount: Positive monetary amount (string, Decimal, or number).
        currency: Currency code, defaults to UGX.
        activity_date: Date the activity occurred, defaults to today.

    Returns:
        The created Transaction instance.

    Raises:
        TransactionRecordingError: If any input is invalid.
    """
    if not user or not user.pk:
        raise TransactionRecordingError("A valid owner is required.")

    if not description or not description.strip():
        raise TransactionRecordingError("Description is required.", field="description")

    valid_types = {c.value for c in Transaction.ActivityType}
    if activity_type not in valid_types:
        raise TransactionRecordingError(
            f"Unsupported activity type '{activity_type}'. Supported types: {', '.join(sorted(valid_types))}.",
            field="activity_type",
        )

    try:
        amount_decimal = Decimal(str(amount))
    except (InvalidOperation, ValueError, TypeError):
        raise TransactionRecordingError("Amount must be a valid number.", field="amount")

    if amount_decimal <= 0:
        raise TransactionRecordingError("Amount must be greater than zero.", field="amount")

    if not currency or len(currency) > 3:
        raise TransactionRecordingError("Currency must be a valid code of up to 3 characters.", field="currency")

    if activity_date is None:
        activity_date = date.today()
    elif isinstance(activity_date, str):
        activity_date = date.fromisoformat(activity_date)

    txn = Transaction(
        owner=user,
        description=description.strip(),
        activity_type=activity_type,
        amount=amount_decimal,
        currency=currency.upper(),
        activity_date=activity_date,
    )
    txn.full_clean()
    txn.save()
    return txn


def resolve_user_by_phone(phone_number):
    """Resolve a normalized WhatsApp phone number to its Django user.

    Returns the user, or None if no profile matches.
    """
    profile = UserProfile.lookup_by_phone_number(phone_number)
    return profile.user if profile else None
