from rest_framework.response import Response
from rest_framework.views import APIView


class HealthView(APIView):
    """Minimal health-check endpoint.

    Returns a simple status indicating that the backend is responding.
    No credentials, environment variables, personal information, or database
    contents are exposed.
    """

    authentication_classes = []
    permission_classes = []

    def get(self, request):
        return Response({"status": "ok"})