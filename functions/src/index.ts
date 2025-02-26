/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { Database } from "../database.types";
import * as logger from "firebase-functions/logger";

import { createClient } from "@supabase/supabase-js";
const supabaseUrl = "https://frdudnkvmymiehngjzww.supabase.co";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

exports.serviceFilter = onRequest(async (request, response) => {
  if (!process.env.SUPABASE_KEY) {
    response.status(500).send("SUPABASE_KEY is not set");
  }

  const supabase = createClient<Database>(
    supabaseUrl,
    process.env.SUPABASE_KEY || ""
  );
  const { services = [] } = request.query;

  let query = supabase
    .from("hotels")
    .select(
      "hotel_id, hotels_services!inner(hotel_id, service_id, services!inner(name))"
    )
    .in("hotels_services.services.name", (services as string[]));

  const { data, error } = await query;

  if (error) {
    response.status(500).send(error);
    return;
  }

  const hotelData = data
    .map((hotel: any) => {
      return {
        hotel_id: hotel.hotel_id,
        services: hotel.hotels_services.map(
          (service: any) => service.services.name
        ),
      };
    })
    .filter((hotel: any) => {
      return (services as string[]).every((service: string) =>
        hotel.services.includes(service)
      );
    });

  const unique = [...new Set(hotelData.map((hotel: any) => hotel.hotel_id))];

  response.send(unique.map((hotelId: any) => ({ hotel_id: hotelId })));
});

exports.hotelChanges = onDocumentWritten("hotels/{hotelId}", async (event) => {
  if (!event.data) {
    return;
  }

  if (!process.env.SUPABASE_KEY) {
    logger.error("SUPABASE_KEY is not set");
    return;
  }

  const supabase = createClient<Database>(
    supabaseUrl,
    process.env.SUPABASE_KEY
  );
  const id = event.params.hotelId;
  const document = event.data.after.data();

  // delete
  if (!document) {
    try {
      await supabase.from("hotels").delete().match({ hotel_id: id });
      await supabase.from("hotels_services").delete().match({ hotel_id: id });
    } catch (error) {
      logger.error("error", error);
    }
    return;
  }

  try {
    await supabase
      .from("hotels")
      .upsert([{ hotel_id: id, updated_at: new Date().toISOString() }]);
    await supabase.from("hotels_services").delete().match({ hotel_id: id });

    await Promise.all(
      document.services.map((service: any) => {
        supabase
          .from("services")
          .select("id")
          .eq("name", service)
          .then((existingService: any) => {
            if (existingService.data?.length) {
              const existingServiceId = existingService.data[0].id;
              return supabase
                .from("hotels_services")
                .upsert([
                  {
                    hotel_id: id,
                    service_id: existingServiceId,
                    updated_at: new Date().toISOString(),
                  },
                ]);
            } else {
              return supabase
                .from("services")
                .insert([{ name: service }])
                .select("id")
                .then((response: any) => {
                  if (!response.data) {
                    return;
                  }

                  return supabase
                    .from("hotels_services")
                    .upsert([
                      {
                        hotel_id: id,
                        service_id: response.data[0].id,
                        updated_at: new Date().toISOString(),
                      },
                    ]);
                });
            }
          });
      })
    );
  } catch (error) {
    logger.error("error", error);
  }
});
