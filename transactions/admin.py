from django.contrib import admin

from django import forms

from .models import Country, Currency, Transaction, UserProfile


class CountryAdminForm(forms.ModelForm):
    class Meta:
        model = Country
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        default_currency = cleaned.get("default_currency")
        currencies = cleaned.get("currencies")
        if default_currency and currencies is not None and default_currency not in currencies:
            self.add_error("default_currency", "The default currency must be in this country's supported currencies.")
        if cleaned.get("is_active") and default_currency and not default_currency.is_active:
            self.add_error("default_currency", "An active country must use an active currency.")
        return cleaned


@admin.register(Currency)
class CurrencyAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "symbol", "is_active")
    list_filter = ("is_active",)
    search_fields = ("code", "name", "symbol")


@admin.register(Country)
class CountryAdmin(admin.ModelAdmin):
    form = CountryAdminForm
    list_display = ("name", "country_code", "default_currency", "is_active")
    list_filter = ("is_active", "default_currency")
    search_fields = ("name", "country_code", "currencies__code")
    filter_horizontal = ("currencies",)


@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    list_display = (
        "description",
        "activity_type",
        "category",
        "amount",
        "currency",
        "activity_date",
        "owner",
        "created_at",
        "is_voided",
    )
    list_filter = ("activity_type", "category", "currency", "is_voided", "activity_date", "created_at")
    search_fields = ("description", "category", "owner__username")


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "phone_number", "preferred_name", "country", "preferred_currency", "created_at")
    list_filter = ("country", "preferred_currency", "created_at", "updated_at")
    search_fields = ("user__username", "phone_number", "preferred_name", "country__name")
    readonly_fields = ("created_at", "updated_at")
