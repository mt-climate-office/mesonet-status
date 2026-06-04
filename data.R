library(tidyverse)
library(magrittr)
library(sf)
library(tigris)
library(rmapshaper)

counties <-
  tigris::counties(
    # cb = TRUE,
    #                resolution = "5m",
                   state = "MT"
  ) %>%
  sf::st_transform("WGS84") %>%
  dplyr::transmute(GEOID, NAME = NAMELSAD) %>%
  dplyr::distinct()

counties <-
  counties %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  rmapshaper::ms_simplify(keep = 0.1,
                          sys = TRUE,
                          sys_mem = 16) %>%
  sf::st_make_valid() %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  # tigris::shift_geometry() %>%
  sf::st_make_valid() %>%
  sf::st_transform("WGS84") %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  sf::st_cast("MULTIPOLYGON") %>%
  dplyr::arrange(GEOID) %>%
  dplyr::left_join(
    counties %>%
      sf::st_drop_geometry() %>%
      dplyr::distinct()
  ) %T>%
  sf::write_sf("data/mt_counties_simple.geojson",
               delete_dsn = TRUE)

state <-
  dplyr::summarise(counties) |>
  dplyr::mutate(GEOID = "30",
                NAME = "Montana") |>
  dplyr::select(GEOID, NAME) %T>%
  sf::write_sf("data/mt_state_simple.geojson",
               delete_dsn = TRUE)


reservations <-
  tigris::native_areas(
    # cb = TRUE
  ) %>%
  sf::st_transform("WGS84") %>%
  dplyr::filter(!stringr::str_detect(NAMELSAD, "Off-Reservation")) %>%
  sf::st_filter(counties) %>%
  dplyr::transmute(GEOID, NAME = NAMELSAD) %>%
  dplyr::distinct()

reservations <-
  reservations %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  rmapshaper::ms_simplify(keep = 0.1,
                          sys = TRUE,
                          sys_mem = 16) %>%
  sf::st_make_valid() %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  # tigris::shift_geometry() %>%
  sf::st_make_valid() %>%
  sf::st_transform("WGS84") %>%
  rmapshaper::ms_explode(sys = TRUE,
                         sys_mem = 16) %>%
  rmapshaper::ms_dissolve(field = "GEOID",
                          sys = TRUE,
                          sys_mem = 16) %>%
  sf::st_cast("MULTIPOLYGON") %>%
  dplyr::arrange(GEOID) %>%
  dplyr::left_join(
    reservations %>%
      sf::st_drop_geometry() %>%
      dplyr::distinct()
  ) %T>%
  sf::write_sf("data/mt_reservations_simple.geojson",
               delete_dsn = TRUE)
