from django.conf import settings
from django.contrib.auth import get_user_model
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication

from .models import UserProfile


class ServiceKeyAuthentication(BaseAuthentication):
    """Authenticate the WhatsApp service using a shared service key.

    The Node.js WhatsApp service sends its credential in the X-Service-Key
    header. When authenticated, the request can also include an
    X-WhatsApp-Phone header identifying the WhatsApp sender. Django resolves
    that phone number to the associated Django user through UserProfile.

    This authentication class never trusts a user ID or phone number supplied
    by an unauthenticated caller. Only callers presenting a valid service key
    may assert a phone number identity.
    """

    keyword = "X-Service-Key"

    def authenticate(self, request):
        service_key = request.META.get("HTTP_X_SERVICE_KEY")
        if not service_key:
            return None

        expected_key = settings.DJANGO_SERVICE_KEY
        if not expected_key or service_key != expected_key:
            raise exceptions.AuthenticationFailed("Invalid service credential.")

        phone_number = request.META.get("HTTP_X_WHATSAPP_PHONE")
        if not phone_number:
            raise exceptions.AuthenticationFailed("Missing WhatsApp phone number.")

        profile = UserProfile.lookup_by_phone_number(phone_number)
        if profile is None:
            raise exceptions.AuthenticationFailed("Unknown WhatsApp phone number.")

        return (profile.user, None)

    def authenticate_header(self, request):
        return self.keyword