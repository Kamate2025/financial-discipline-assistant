from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from django.contrib.auth import get_user_model

from .models import Transaction, UserProfile
from .serializers import TransactionSerializer


class TransactionListCreateView(generics.ListCreateAPIView):
    """List the authenticated user's transactions or create a new one.

    Ownership is always assigned from the authenticated user, never from the
    request payload. Users can only see and create their own records.
    """

    serializer_class = TransactionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Transaction.objects.filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class TransactionRetrieveUpdateDestroyView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update, or delete a single transaction belonging to the authenticated user.

    Ownership and automatic timestamps are protected from client modification.
    Users can only modify or delete their own records; access to another user's
    record returns a 404 response.
    """

    serializer_class = TransactionSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return Transaction.objects.filter(owner=self.request.user)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        self.perform_destroy(instance)
        return Response(status=status.HTTP_204_NO_CONTENT)